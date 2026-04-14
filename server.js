const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const { execSync } = require('child_process');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const crypto = require('crypto');
const YTDlpWrap = require('yt-dlp-wrap').default;

// Detect ffmpeg path: prefer system binary, fall back to ffmpeg-static
let ffmpegPath;
try {
  ffmpegPath = execSync('which ffmpeg').toString().trim();
  console.log('System ffmpeg found at:', ffmpegPath);
} catch(e) {
  console.warn('System ffmpeg not found, falling back to ffmpeg-static');
  ffmpegPath = require('ffmpeg-static');
  console.log('ffmpeg-static path:', ffmpegPath);
}
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const YTDLP_PATH = path.join(os.tmpdir(), 'yt-dlp');
let ytDlp;

// Unwrap array values from WeWeb variable chips
function unwrap(val) {
  if (Array.isArray(val)) return val[0];
  return val;
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

async function initYtDlp() {
  console.log('Downloading yt-dlp standalone binary...');
  const response = await axios.get(
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
    { responseType: 'arraybuffer', maxRedirects: 10 }
  );
  fs.writeFileSync(YTDLP_PATH, response.data);
  fs.chmodSync(YTDLP_PATH, '755');
  const size = fs.statSync(YTDLP_PATH).size;
  console.log(`yt-dlp downloaded, size: ${size} bytes`);
  ytDlp = new YTDlpWrap(YTDLP_PATH);
  console.log('yt-dlp ready');
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'gif-banner-api' }));

async function downloadClip(url) {
  const tmpFile = path.join(os.tmpdir(), `clip_${uid()}.mp4`);
  console.log('Starting download:', url);
  try {
    await ytDlp.execPromise([
      url,
      '-f', 'best',
      '--no-playlist',
      '--socket-timeout', '30',
      '--retries', '2',
      '-o', tmpFile
    ]);
    console.log('Download complete:', tmpFile);
    if (!fs.existsSync(tmpFile)) throw new Error('Downloaded file not found after yt-dlp');
    const size = fs.statSync(tmpFile).size;
    console.log('File size:', size, 'bytes');
    return tmpFile;
  } catch(err) {
    console.error('Download failed:', err.message);
    throw err;
  }
}

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.warn('ffprobe failed, using fallback duration:', err.message);
        return resolve(30);
      }
      const duration = metadata.format.duration || 30;
      console.log('Video duration:', duration, 'seconds');
      resolve(duration);
    });
  });
}

// Extract frames as PNG buffers from a clip
function extractFrames(filePath, startTime, duration, fps) {
  return new Promise(async (resolve, reject) => {
    const videoDuration = await getVideoDuration(filePath);
    const safeStart = Math.min(parseFloat(startTime || 0), videoDuration - 0.5);
    const safeDuration = Math.min(parseFloat(duration || 5), videoDuration - safeStart);
    const framesDir = path.join(os.tmpdir(), `frames_${uid()}`);
    fs.mkdirSync(framesDir, { recursive: true });
    console.log(`Extracting frames: start=${safeStart}s duration=${safeDuration}s fps=${fps} from ${filePath}`);

    ffmpeg(filePath)
      .seekInput(safeStart)
      .duration(safeDuration)
      .fps(fps)
      .output(path.join(framesDir, 'frame_%04d.png'))
      .on('start', (cmd) => console.log('ffmpeg frames command:', cmd))
      .on('end', () => {
        const files = fs.readdirSync(framesDir)
          .filter(f => f.endsWith('.png'))
          .sort()
          .map(f => fs.readFileSync(path.join(framesDir, f)));
        fs.readdirSync(framesDir).forEach(f => fs.unlinkSync(path.join(framesDir, f)));
        fs.rmdirSync(framesDir);
        console.log(`Extracted ${files.length} frames`);
        resolve(files);
      })
      .on('error', (err) => {
        console.error('ffmpeg frames error:', err.message);
        try {
          fs.readdirSync(framesDir).forEach(f => fs.unlinkSync(path.join(framesDir, f)));
          fs.rmdirSync(framesDir);
        } catch(e) {}
        reject(err);
      })
      .run();
  });
}

// Extract a single GIF preview for one clip
function extractGifFromFile(filePath, startTime, duration) {
  return new Promise(async (resolve, reject) => {
    const videoDuration = await getVideoDuration(filePath);
    const safeStart = Math.min(parseFloat(startTime || 0), videoDuration - 1);
    const safeDuration = Math.min(parseFloat(duration || 5), videoDuration - safeStart);
    console.log(`Extracting GIF: start=${safeStart}s duration=${safeDuration}s from ${filePath}`);

    const tmpGif = path.join(os.tmpdir(), `preview_${uid()}.gif`);
    ffmpeg(filePath)
      .seekInput(safeStart)
      .duration(safeDuration)
      .output(tmpGif)
      .outputOptions([
        '-vf', 'fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse'
      ])
      .on('start', (cmd) => console.log('ffmpeg GIF command:', cmd))
      .on('end', () => {
        console.log('ffmpeg GIF finished');
        if (!fs.existsSync(tmpGif)) {
          try { fs.unlinkSync(filePath); } catch(e) {}
          return reject(new Error('ffmpeg did not produce output GIF'));
        }
        const buf = fs.readFileSync(tmpGif);
        fs.unlinkSync(tmpGif);
        try { fs.unlinkSync(filePath); } catch(e) {}
        console.log('GIF size:', buf.length, 'bytes');
        resolve(buf);
      })
      .on('error', (err) => {
        console.error('ffmpeg error:', err.message);
        try { fs.unlinkSync(filePath); } catch(e) {}
        reject(err);
      })
      .run();
  });
}

// Build animated GIF banner from 3 sets of frames
async function buildAnimatedBanner(frameRows, fps) {
  const minFrames = Math.min(...frameRows.map(f => f.length));
  console.log(`Building banner: ${minFrames} frames at ${fps}fps, 744x400`);

  const BANNER_W = 744;
  const BANNER_H = 400;
  const PANEL_W = 248;
  const PANEL_H = 400;

  const framesDir = path.join(os.tmpdir(), `banner_${uid()}`);
  fs.mkdirSync(framesDir, { recursive: true });

  for (let i = 0; i < minFrames; i++) {
    const panels = await Promise.all(
      frameRows.map(frames =>
        sharp(frames[i])
          .resize(PANEL_W, PANEL_H, { fit: 'cover', position: 'centre' })
          .png()
          .toBuffer()
      )
    );

    const composite = await sharp({
      create: { width: BANNER_W, height: BANNER_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
    })
      .composite([
        { input: panels[0], left: 0, top: 0 },
        { input: panels[1], left: PANEL_W, top: 0 },
        { input: panels[2], left: PANEL_W * 2, top: 0 }
      ])
      .png()
      .toBuffer();

    fs.writeFileSync(path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`), composite);
  }

  console.log(`Composited ${minFrames} banner frames, generating GIF...`);

  const outputGif = path.join(os.tmpdir(), `banner_${uid()}.gif`);
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(framesDir, 'frame_%04d.png'))
      .inputOptions([`-framerate ${fps}`])
      .output(outputGif)
      .outputOptions([
        '-vf', `fps=${fps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
        '-loop', '0'
      ])
      .on('start', (cmd) => console.log('Banner GIF command:', cmd))
      .on('end', () => {
        console.log('Banner GIF created');
        resolve();
      })
      .on('error', (err) => {
        console.error('Banner GIF error:', err.message);
        reject(err);
      })
      .run();
  });

  fs.readdirSync(framesDir).forEach(f => fs.unlinkSync(path.join(framesDir, f)));
  fs.rmdirSync(framesDir);

  const gifBuf = fs.readFileSync(outputGif);
  fs.unlinkSync(outputGif);
  console.log('Final banner GIF size:', gifBuf.length, 'bytes');
  return gifBuf;
}

app.post('/preview-clip', async (req, res) => {
  try {
    console.log('Body received:', JSON.stringify(req.body));
    const url = unwrap(req.body.url);
    const start = unwrap(req.body.start);
    const duration = unwrap(req.body.duration);
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const clipFile = await downloadClip(url);
    const gifBuf = await extractGifFromFile(clipFile, start, duration);
    console.log('Sending GIF preview response');
    res.json({ previewUrl: `data:image/gif;base64,${gifBuf.toString('base64')}` });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate-banner', async (req, res) => {
  try {
    console.log('Generate banner body:', JSON.stringify(req.body));
    const { clips } = req.body;
    if (!clips || clips.length !== 3) return res.status(400).json({ error: 'Exactly 3 clips required' });

    const FPS = 10;

    // Unwrap any array values from WeWeb
    const normalizedClips = clips.map((clip, i) => {
      const url = unwrap(clip.url);
      const start = unwrap(clip.start);
      const duration = unwrap(clip.duration);
      if (!url) throw new Error(`Clip ${i + 1} has no URL`);
      return { url, start, duration };
    });

    console.log('Normalized clips:', JSON.stringify(normalizedClips));

    // Download all 3 clips in parallel
    console.log('Downloading all 3 clips...');
    const clipFiles = await Promise.all(normalizedClips.map(clip => downloadClip(clip.url)));

    // Extract frames from all 3 clips in parallel
    console.log('Extracting frames from all 3 clips...');
    const frameRows = await Promise.all(
      clipFiles.map((file, i) => extractFrames(file, normalizedClips[i].start, normalizedClips[i].duration, FPS))
    );

    // Cleanup clip files
    clipFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });

    // Build animated banner
    const bannerGif = await buildAnimatedBanner(frameRows, FPS);

    console.log('Sending banner response');
    res.json({ bannerUrl: `data:image/gif;base64,${bannerGif.toString('base64')}` });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

initYtDlp().then(() => {
  app.listen(PORT, () => console.log(`gif-banner-api running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init yt-dlp:', err);
  process.exit(1);
});
