import {
  Injectable,
  HttpException,
  HttpStatus,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { R2Service } from '../../infrastructure/r2/r2.service';

const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegStatic = require('ffmpeg-static');

const MAX_SONG_DURATION_SECONDS = 600;
const MIN_SONG_DURATION_SECONDS = 30;

@Injectable()
export class SongFilesService implements OnModuleInit {
  private readonly uploadsDir = path.join(process.cwd(), 'uploads');
  private ytDlpWrap: any;

  constructor(private readonly r2Service: R2Service) {
    fs.ensureDirSync(this.uploadsDir);
  }

  async onModuleInit() {
    const isWindows = os.platform() === 'win32';

    // 1️⃣ Check if yt-dlp is already in the system path (e.g. Docker)
    let binaryPath = '';
    try {
      const { execSync } = require('child_process');
      const cmd = isWindows ? 'where yt-dlp' : 'which yt-dlp';
      binaryPath = execSync(cmd).toString().trim();
      console.log(`Using system yt-dlp found at: ${binaryPath}`);
    } catch (err) {
      // Not in path, fallback to local binary
      const binaryName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
      binaryPath = path.join(process.cwd(), binaryName);
    }

    if (!fs.existsSync(binaryPath)) {
      console.log('Downloading yt-dlp binary...');
      await YTDlpWrap.downloadFromGithub(binaryPath);
      if (!isWindows) {
        fs.chmodSync(binaryPath, '755');
      }
      console.log('yt-dlp downloaded successfully.');
    }

    this.ytDlpWrap = new YTDlpWrap(binaryPath);
  }

  async downloadAudio(videoId: string) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    // const filename = `${videoId}-${Date.now()}.m4a`
    const filename = `${videoId}.m4a`;

    // Use a temporary file for more reliable extraction (ffmpeg often needs a seekable output for headers)
    const tempFilePath = path.join(os.tmpdir(), `${videoId}-${Date.now()}`);
    const finalPath = `${tempFilePath}.m4a`;

    const ytDlpCookiesPath =
      process.env.YTDLP_COOKIES_PATH ?? path.join(process.cwd(), 'cookies.txt');
    const ytDlpArgs = [
  url,
  '-f',
  'ba/b',
  '-x',
  '--audio-format',
  'aac',
  '--audio-quality',
  '128K',
  '--ffmpeg-location',
  ffmpegStatic,
  '--no-check-certificate',
  '-4',
  '--cache-dir',
  os.tmpdir(),
  '--js-runtimes',
  'deno',
  '--remote-components',
  'ejs:github',
  '--fragment-retries',
  '10',
  '--retry-sleep',
  '2',
  '--cookies',
  ytDlpCookiesPath,
  '-o',
  tempFilePath,
];






    console.log(`Starting download for ${videoId} to ${finalPath}...`);

    const faststartPath = `${tempFilePath}-faststart.m4a`;

    try {
      // Execute download and extraction to the temporary file
      await this.ytDlpWrap.execPromise(ytDlpArgs);

      if (!fs.existsSync(finalPath)) {
        throw new Error('Extraction finished but output file was not found.');
      }

      const duration = await this.extractDurationInSeconds(finalPath);

      // 🛡️ Layer 4: Post-download Safety Net
      if (duration > MAX_SONG_DURATION_SECONDS) {
        console.warn(
          `[Layer 4] Audio too long for ${videoId}: ${duration}s. Rejecting...`,
        );
        throw new Error(
          `The processed audio duration (${duration}s) exceeds the maximum allowed limit of ${MAX_SONG_DURATION_SECONDS}s.`,
        );
      } else if (duration < MIN_SONG_DURATION_SECONDS) {
        console.warn(
          `[Layer 4] Audio too short for ${videoId}: ${duration}s. Rejecting...`,
        );
        throw new Error(
          `The processed audio duration (${duration}s) is less than the minimum allowed limit of ${MIN_SONG_DURATION_SECONDS}s.`,
        );
      }


      // ✅ ADD THIS — move moov atom to front for instant seek
      await this.applyFaststart(finalPath, faststartPath);


      console.log(`Extraction complete. Uploading ${finalPath} to R2...`);

      // Read the file into a buffer to avoid Stream/Multipart Cloudflare 502 bugs
      // const fileBuffer = fs.readFileSync(finalPath);
      const fileBuffer = fs.readFileSync(faststartPath); // ← read faststart file
      const key = await this.r2Service.uploadFileBuffer(fileBuffer, filename);

      // Cleanup the temporary file
      await fs.remove(finalPath).catch((err) => console.warn('Failed to cleanup temp file:', err));
      await fs.remove(faststartPath).catch((err) => console.warn('Failed to cleanup faststart file:', err));


      return {
        success: true,
        r2Key: key,
        duration,
      };
    } catch (err: any) {
      console.error('❌ Audio Download/Upload failed:', err.message);

      // Attempt cleanup if file exists
      if (fs.existsSync(finalPath)) {
        await fs.remove(finalPath).catch(() => { });
      }
      // also cleanup faststart file if it exists
      if (fs.existsSync(faststartPath)) {
        await fs.remove(faststartPath).catch(() => { });
      }



      throw new HttpException(
        `Failed to process audio: ${err.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private extractDurationInSeconds(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpegStatic as string, ['-i', filePath]);
      let stderr = '';

      ffmpegProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      ffmpegProcess.on('error', (error) => {
        reject(error);
      });

      ffmpegProcess.on('close', () => {
        const match = stderr.match(
          /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/,
        );

        if (!match) {
          reject(new Error('Failed to extract duration from processed audio.'));
          return;
        }

        const hours = Number(match[1]);
        const minutes = Number(match[2]);
        const seconds = Number(match[3]);

        resolve(Math.round(hours * 3600 + minutes * 60 + seconds));
      });
    });
  }

  // ✅ ADD THIS METHOD
  private applyFaststart(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpegProcess = spawn(ffmpegStatic as string, [
        '-i', inputPath,
        '-c', 'copy',           // no re-encoding
        '-movflags', '+faststart', // move moov atom to front
        '-y',                   // overwrite if exists
        outputPath,
      ]);

      let stderr = '';
      ffmpegProcess.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      ffmpegProcess.on('error', reject);
      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          console.log(`[faststart] moov atom moved to front for ${outputPath}`);
          resolve();
        } else {
          reject(new Error(`ffmpeg faststart failed with code ${code}: ${stderr}`));
        }
      });
    });
  }

}
