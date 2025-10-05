import * as sc from 'supercolliderjs';
import * as fs from 'fs';
import * as path from 'path';

interface BufferInfo {
  bufnum: number;
  duration: number;
}

interface ScheduledPlay {
  time: number;
  filepath: string;
  options: {
    volume?: number;
    startPos?: number;
    duration?: number;
  };
  sequenceName: string;
}

/**
 * SuperCollider audio player with low-latency scheduling
 */
export class SuperColliderPlayer {
  private server: any = null;
  private bufferCache: Map<string, BufferInfo> = new Map();
  private bufferDurations: Map<number, number> = new Map();
  private nextBufnum = 0;
  private synthDefPath: string;

  // Scheduler
  public isRunning = false;
  private startTime = 0;
  private scheduledPlays: ScheduledPlay[] = [];
  private sequenceEvents: Map<string, ScheduledPlay[]> = new Map();
  private intervalId: NodeJS.Timeout | null = null;

  constructor() {
    // @ts-ignore - __dirname is available in CommonJS
    this.synthDefPath = path.join(__dirname, '../../supercollider/synthdefs/orbitPlayBuf.scsyndef');
  }

  /**
   * Boot SuperCollider server and load SynthDef
   */
  async boot(): Promise<void> {
    console.log('🎵 Booting SuperCollider server...');

    // @ts-ignore - supercolliderjs types are incomplete
    this.server = await sc.server.boot({
      scsynth: '/Applications/SuperCollider.app/Contents/Resources/scsynth',
      debug: false,
    });

    console.log('✅ SuperCollider server ready');

    // Load SynthDef
    const synthDefData = fs.readFileSync(this.synthDefPath);
    await this.server.send.msg(['/d_recv', synthDefData]);

    // Wait for SynthDef to be ready
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log('✅ SynthDef loaded');
  }

  /**
   * Load audio file into buffer
   */
  async loadBuffer(filepath: string): Promise<BufferInfo> {
    if (this.bufferCache.has(filepath)) {
      return this.bufferCache.get(filepath)!;
    }

    const bufnum = this.nextBufnum++;

    await this.server.send.msg(['/b_allocRead', bufnum, filepath, 0, -1]);

    // Query duration
    const duration = await this.queryBufferDuration(bufnum);

    const bufferInfo: BufferInfo = { bufnum, duration };
    this.bufferCache.set(filepath, bufferInfo);
    this.bufferDurations.set(bufnum, duration);

    return bufferInfo;
  }

  /**
   * Query buffer duration (simplified)
   */
  private async queryBufferDuration(bufnum: number): Promise<number> {
    // TODO: Implement proper /b_query response handling
    return 0.5; // Assume 0.5 second for drum samples
  }

  /**
   * Get audio duration from cache
   */
  getAudioDuration(filepath: string): number {
    const bufferInfo = this.bufferCache.get(filepath);
    return bufferInfo?.duration ?? 1.0;
  }

  /**
   * Schedule a play event
   */
  scheduleEvent(filepath: string, startTimeMs: number, volume = 80, sequenceName = ''): void {
    const play: ScheduledPlay = {
      time: startTimeMs,
      filepath,
      options: { volume },
      sequenceName,
    };

    this.scheduledPlays.push(play);
    this.scheduledPlays.sort((a, b) => a.time - b.time);

    // Track sequence events
    if (sequenceName) {
      if (!this.sequenceEvents.has(sequenceName)) {
        this.sequenceEvents.set(sequenceName, []);
      }
      this.sequenceEvents.get(sequenceName)!.push(play);
    }
  }

  /**
   * Schedule a slice event (for chop)
   */
  scheduleSliceEvent(
    filepath: string,
    startTimeMs: number,
    sliceIndex: number,
    totalSlices: number,
    volume = 80,
    sequenceName = ''
  ): void {
    const duration = this.getAudioDuration(filepath);
    const sliceDuration = duration / totalSlices;
    const startPos = sliceIndex * sliceDuration;

    const play: ScheduledPlay = {
      time: startTimeMs,
      filepath,
      options: {
        volume,
        startPos,
        duration: sliceDuration,
      },
      sequenceName,
    };

    this.scheduledPlays.push(play);
    this.scheduledPlays.sort((a, b) => a.time - b.time);

    // Track sequence events
    if (sequenceName) {
      if (!this.sequenceEvents.has(sequenceName)) {
        this.sequenceEvents.set(sequenceName, []);
      }
      this.sequenceEvents.get(sequenceName)!.push(play);
    }
  }

  /**
   * Execute playback
   */
  private async executePlayback(
    filepath: string,
    options: { volume?: number; startPos?: number; duration?: number },
    sequenceName: string,
    scheduledTime: number
  ): Promise<void> {
    const launchTime = Date.now();
    const actualStartTime = launchTime - this.startTime;
    const drift = actualStartTime - scheduledTime;

    console.log(
      `🔊 Playing: ${sequenceName} at ${actualStartTime}ms (scheduled: ${scheduledTime}ms, drift: ${drift}ms)`
    );

    const { bufnum } = await this.loadBuffer(filepath);
    const volume = options.volume !== undefined ? options.volume / 100 : 0.5;
    const startPos = options.startPos ?? 0;
    const duration = options.duration ?? 0;

    await this.server.send.msg([
      '/s_new',
      'orbitPlayBuf',
      -1,
      0,
      0,
      'bufnum',
      bufnum,
      'amp',
      volume,
      'rate',
      1.0,
      'startPos',
      startPos,
      'duration',
      duration,
    ]);
  }

  /**
   * Start scheduler
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();

    console.log('✅ Global running');

    this.scheduledPlays.sort((a, b) => a.time - b.time);

    this.intervalId = setInterval(() => {
      const now = Date.now() - this.startTime;

      while (this.scheduledPlays.length > 0 && this.scheduledPlays[0].time <= now) {
        const play = this.scheduledPlays.shift()!;
        this.executePlayback(play.filepath, play.options, play.sequenceName, play.time);
      }
    }, 1);
  }

  /**
   * Stop scheduler
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('✅ Global stopped');
  }

  /**
   * Stop all and clear events
   */
  stopAll(): void {
    this.stop();
    this.scheduledPlays = [];
    this.sequenceEvents.clear();
  }

  /**
   * Clear events for a specific sequence
   */
  clearSequenceEvents(sequenceName: string): void {
    this.scheduledPlays = this.scheduledPlays.filter(play => play.sequenceName !== sequenceName);
    this.sequenceEvents.delete(sequenceName);
  }

  /**
   * Quit SuperCollider server
   */
  async quit(): Promise<void> {
    if (this.server) {
      this.stop();
      await this.server.quit();
      console.log('👋 SuperCollider server quit');
    }
  }
}
