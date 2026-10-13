// SPDX-FileCopyrightText: 2026 Klarälvdalens Datakonsult AB, a KDAB Group company <info@kdab.com>
// SPDX-License-Identifier: GPL-2.0-or-later

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import type { Connection } from './connection';

export interface VideoOptions {
  /** Frames per second of the output (default 25). */
  fps?: number;
  /** Fit the video into this size (letterboxed). Default: the windows' size times `scale`. */
  size?: { width: number; height: number };
  /** Scale factor when no `size` is given (default 1). */
  scale?: number;
  /** JPEG quality of the transferred frames, 1-100 (default 90). */
  quality?: number;
  /** Draw a title bar above each window (default true; offscreen windows have no decorations). */
  chrome?: boolean;
  /** Draw the synthesized mouse pointer (default true). */
  cursor?: boolean;
  /** ffmpeg executable; defaults to $QT_PLAYWRIGHT_FFMPEG, then `ffmpeg` in PATH. */
  ffmpeg?: string;
}

/** Like Playwright's `recordVideo` context option: record into `dir`, one file per app. */
export interface RecordVideoOptions extends VideoOptions {
  dir: string;
  /** File extension / container: mp4 (H.264, default), webm (VP8), mkv, mov or gif. */
  format?: 'mp4' | 'webm' | 'mkv' | 'mov' | 'gif';
}

interface StartReply {
  recordingId: number;
  width: number;
  height: number;
  fps: number;
  format: 'jpeg' | 'png';
}

function encoderArgs(path: string): string[] {
  switch (extname(path).toLowerCase()) {
    case '.mp4':
    case '.m4v':
    case '.mov':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    case '.mkv':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
    case '.webm':
      return ['-c:v', 'libvpx', '-b:v', '2M', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p'];
    case '.gif':
      return ['-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer'];
    default:
      throw new Error(`unsupported video format "${extname(path)}" (use .mp4, .webm, .mkv, .mov or .gif)`);
  }
}

/**
 * A video recording of the application's windows, encoded with ffmpeg.
 *
 * The application streams a frame whenever the picture changes; frames are repeated
 * here according to their timestamps, so the video plays back in real time.
 */
export class Video {
  private ffmpeg!: ChildProcess;
  private ffmpegError = '';
  private recordingId = 0;
  private fps = 25;
  private current: Buffer | undefined;
  private written = 0;
  private startedAt = 0;
  private lastTimestamp = 0;
  private stopping: Promise<string> | undefined;
  private finishing: Promise<string> | undefined;
  private finished!: Promise<string>;
  private resolveFinished!: (path: string) => void;
  private rejectFinished!: (e: Error) => void;
  private readonly onFrame = (data: Buffer) => this.frame(data);
  private readonly onClose = () => void this.finish(Date.now() - this.startedAt).catch(() => undefined);

  private constructor(
    private readonly connection: Connection,
    private readonly filePath: string,
  ) {
    this.finished = new Promise((resolve, reject) => {
      this.resolveFinished = resolve;
      this.rejectFinished = reject;
    });
    this.finished.catch(() => undefined); // reported through stop()/saveAs()
  }

  /** Starts recording into @p path; the container/codec follows the file extension. */
  static async start(connection: Connection, path: string, options: VideoOptions = {}): Promise<Video> {
    const encoder = encoderArgs(path); // validate before starting anything
    await mkdir(dirname(path), { recursive: true });
    const video = new Video(connection, path);

    const fps = Math.max(1, Math.min(60, Math.round(options.fps ?? 25)));
    // the frame format is known only after startRecording, but ffmpeg must be ready first:
    // start the recording, then ffmpeg, buffering frames that arrive meanwhile
    const early: Buffer[] = [];
    const collect = (b: Buffer) => early.push(b);
    connection.on('binary', collect);
    let reply: StartReply;
    try {
      reply = await connection.call<StartReply>('startRecording', {
        fps,
        size: options.size,
        scale: options.scale,
        quality: options.quality,
        chrome: options.chrome,
        cursor: options.cursor,
      });
    } finally {
      connection.off('binary', collect);
    }
    video.recordingId = reply.recordingId;
    video.fps = reply.fps;
    video.startedAt = Date.now();

    const ffmpegPath = options.ffmpeg ?? process.env.QT_PLAYWRIGHT_FFMPEG ?? 'ffmpeg';
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(reply.fps), '-c:v', reply.format === 'jpeg' ? 'mjpeg' : 'png', '-i', '-',
      ...encoder, path,
    ];
    video.ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    video.ffmpeg.stderr!.on('data', (c: Buffer) => (video.ffmpegError += c.toString()));
    video.ffmpeg.stdin!.on('error', () => undefined); // reported via the exit code
    try {
      await once(video.ffmpeg, 'spawn');
    } catch (e) {
      await connection.call('stopRecording', { recordingId: reply.recordingId }).catch(() => undefined);
      throw new Error(
        `could not start ffmpeg (${ffmpegPath}): ${(e as Error).message}. ` +
          'Install ffmpeg or set QT_PLAYWRIGHT_FFMPEG / the ffmpeg option.',
      );
    }

    for (const b of early) video.frame(b);
    connection.on('binary', video.onFrame);
    connection.once('close', video.onClose);
    return video;
  }

  /** Path of the video file; complete once the recording stopped (app closed or stop()). */
  async path(): Promise<string> {
    return this.filePath;
  }

  /** Stops recording and finalizes the file; resolves with its path. Idempotent. */
  stop(): Promise<string> {
    if (!this.stopping) {
      this.stopping = (async () => {
        let duration = Date.now() - this.startedAt;
        try {
          const r = await this.connection.call<{ duration: number }>('stopRecording', { recordingId: this.recordingId });
          duration = r.duration;
        } catch {
          // the application is gone; keep what we have
        }
        return this.finish(duration);
      })();
    }
    return this.stopping;
  }

  /** Copies the finished video to @p path (waits for the recording to stop). */
  async saveAs(path: string): Promise<void> {
    const src = await this.finished;
    await mkdir(dirname(path), { recursive: true });
    await copyFile(src, path);
  }

  /** Deletes the video file once the recording has stopped. */
  async delete(): Promise<void> {
    const src = await this.finished.catch(() => this.filePath);
    await unlink(src).catch(() => undefined);
  }

  private write(frame: Buffer): void {
    this.ffmpeg.stdin!.write(frame);
    ++this.written;
  }

  private frame(data: Buffer): void {
    if (data.length < 20 || data.toString('latin1', 0, 4) !== 'QTPW') return;
    if (data.readUInt32LE(8) !== this.recordingId) return;
    const t = data.readDoubleLE(12);
    const image = data.subarray(20);
    this.lastTimestamp = Math.max(this.lastTimestamp, t);
    // repeat the previous picture until this frame's time slot
    const slot = Math.round((t * this.fps) / 1000);
    if (this.current) while (this.written < slot) this.write(this.current);
    this.current = image;
  }

  private finish(duration: number): Promise<string> {
    this.finishing ??= this.doFinish(duration);
    return this.finishing;
  }

  private async doFinish(duration: number): Promise<string> {
    this.connection.off('binary', this.onFrame);
    this.connection.off('close', this.onClose);
    if (this.ffmpeg.exitCode === null && this.ffmpeg.stdin!.writable) {
      const end = Math.max(Math.round((Math.max(duration, this.lastTimestamp) * this.fps) / 1000), this.written + 1);
      if (this.current) while (this.written < end) this.write(this.current);
      this.ffmpeg.stdin!.end();
    }
    const [code] = this.ffmpeg.exitCode !== null ? [this.ffmpeg.exitCode] : await once(this.ffmpeg, 'exit');
    if (code !== 0) {
      const error = new Error(`ffmpeg failed (exit code ${code}) writing ${this.filePath}:\n${this.ffmpegError}`);
      this.rejectFinished(error);
      throw error;
    }
    this.resolveFinished(this.filePath);
    return this.filePath;
  }
}
