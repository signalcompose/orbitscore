#!/usr/bin/env node

/**
 * Generate test WAV files for OrbitScore testing
 * Creates various drum sounds and melodic samples
 */

const fs = require('fs');
const path = require('path');
const { WaveFile } = require('wavefile');

// Audio generation parameters
const SAMPLE_RATE = 48000;
const BIT_DEPTH = '32f'; // 32-bit float
const DURATION_SECONDS = 1;

/**
 * Generate a sine wave
 */
function generateSineWave(frequency, duration, sampleRate) {
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate);
  }
  
  return samples;
}

/**
 * Generate a kick drum sound
 */
function generateKick(sampleRate) {
  const duration = 0.5;
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Pitch envelope: starts at 150Hz, drops to 50Hz
    const pitch = 150 * Math.exp(-35 * t) + 50;
    // Amplitude envelope
    const amp = Math.exp(-35 * t);
    // Add some click at the beginning
    const click = (i < sampleRate * 0.005) ? Math.random() * 0.5 : 0;
    
    samples[i] = amp * Math.sin(2 * Math.PI * pitch * t) + click;
  }
  
  return samples;
}

/**
 * Generate a snare drum sound
 */
function generateSnare(sampleRate) {
  const duration = 0.2;
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Amplitude envelope
    const amp = Math.exp(-35 * t);
    // Mix of tone (200Hz) and noise
    const tone = Math.sin(2 * Math.PI * 200 * t);
    const noise = Math.random() * 2 - 1;
    
    samples[i] = amp * (tone * 0.5 + noise * 0.5);
  }
  
  return samples;
}

/**
 * Generate a hi-hat sound
 */
function generateHiHat(sampleRate, closed = true) {
  const duration = closed ? 0.05 : 0.15;
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Amplitude envelope
    const amp = Math.exp(closed ? -350 * t : -50 * t);
    // High frequency noise
    const noise = Math.random() * 2 - 1;
    // High-pass filter simulation (emphasis on high frequencies)
    const filtered = noise * Math.random();
    
    samples[i] = amp * filtered;
  }
  
  return samples;
}

/**
 * Generate a bass note
 */
function generateBass(frequency, sampleRate) {
  const duration = 1;
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Amplitude envelope with sustain
    const amp = i < sampleRate * 0.01 ? i / (sampleRate * 0.01) : Math.exp(-0.5 * (t - 0.01));
    // Add harmonics for richness
    const fundamental = Math.sin(2 * Math.PI * frequency * t);
    const harmonic2 = Math.sin(2 * Math.PI * frequency * 2 * t) * 0.3;
    const harmonic3 = Math.sin(2 * Math.PI * frequency * 3 * t) * 0.1;
    
    samples[i] = amp * (fundamental + harmonic2 + harmonic3);
  }
  
  return samples;
}

/**
 * Generate a chord (multiple sine waves)
 */
function generateChord(frequencies, sampleRate) {
  const duration = 2;
  const numSamples = Math.floor(sampleRate * duration);
  const samples = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Amplitude envelope
    const amp = Math.exp(-0.5 * t);
    
    let sample = 0;
    for (const freq of frequencies) {
      sample += Math.sin(2 * Math.PI * freq * t) / frequencies.length;
    }
    
    samples[i] = amp * sample;
  }
  
  return samples;
}

/**
 * Generate a simple arpeggio
 */
function generateArpeggio(baseFreq, sampleRate) {
  const notes = [1, 1.25, 1.5, 2]; // Root, major third, fifth, octave
  const noteDuration = 0.25;
  const totalDuration = noteDuration * notes.length;
  const numSamples = Math.floor(sampleRate * totalDuration);
  const samples = new Float32Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const noteIndex = Math.floor(t / noteDuration);
    if (noteIndex < notes.length) {
      const noteTime = t - noteIndex * noteDuration;
      const freq = baseFreq * notes[noteIndex];
      // Note envelope
      const amp = Math.exp(-5 * noteTime);
      samples[i] = amp * Math.sin(2 * Math.PI * freq * i / sampleRate);
    }
  }
  
  return samples;
}

/**
 * Save samples as WAV file
 */
function saveWav(filename, samples, sampleRate) {
  const wav = new WaveFile();
  
  // Create WAV with proper format
  wav.fromScratch(1, sampleRate, '32f', samples);
  
  // Write to file
  const outputPath = path.join(__dirname, 'audio', filename);
  fs.writeFileSync(outputPath, wav.toBuffer());
  console.log(`Created: ${outputPath}`);
}

/**
 * Generate all test audio files
 */
function generateAllTestAudio() {
  console.log('Generating test audio files...\n');
  
  // Drum sounds
  console.log('Generating drum sounds...');
  saveWav('kick.wav', generateKick(SAMPLE_RATE), SAMPLE_RATE);
  saveWav('snare.wav', generateSnare(SAMPLE_RATE), SAMPLE_RATE);
  saveWav('hihat_closed.wav', generateHiHat(SAMPLE_RATE, true), SAMPLE_RATE);
  saveWav('hihat_open.wav', generateHiHat(SAMPLE_RATE, false), SAMPLE_RATE);
  
  // Bass sounds
  console.log('\nGenerating bass sounds...');
  saveWav('bass_c1.wav', generateBass(65.41, SAMPLE_RATE), SAMPLE_RATE); // C2
  saveWav('bass_e1.wav', generateBass(82.41, SAMPLE_RATE), SAMPLE_RATE); // E2
  saveWav('bass_g1.wav', generateBass(98.00, SAMPLE_RATE), SAMPLE_RATE); // G2
  
  // Melodic sounds
  console.log('\nGenerating melodic sounds...');
  saveWav('sine_440.wav', generateSineWave(440, 1, SAMPLE_RATE), SAMPLE_RATE); // A4
  saveWav('sine_880.wav', generateSineWave(880, 1, SAMPLE_RATE), SAMPLE_RATE); // A5
  
  // Chords
  console.log('\nGenerating chord sounds...');
  // C major chord (C4, E4, G4)
  saveWav('chord_c_major.wav', generateChord([261.63, 329.63, 392.00], SAMPLE_RATE), SAMPLE_RATE);
  // A minor chord (A4, C5, E5)
  saveWav('chord_a_minor.wav', generateChord([440, 523.25, 659.25], SAMPLE_RATE), SAMPLE_RATE);
  
  // Arpeggio
  console.log('\nGenerating arpeggio...');
  saveWav('arpeggio_c.wav', generateArpeggio(261.63, SAMPLE_RATE), SAMPLE_RATE); // C4 base
  
  console.log('\n✅ All test audio files generated successfully!');
}

// Check if wavefile is installed
try {
  require('wavefile');
} catch (e) {
  console.error('Error: wavefile package not found.');
  console.log('Please install it first: npm install wavefile');
  process.exit(1);
}

// Run generation
generateAllTestAudio();