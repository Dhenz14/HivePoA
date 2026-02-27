/**
 * Health Score Encoding System for CDN Node Monitoring
 * Repurposed from SPK Network's trole/healthScore.js
 * 
 * Uses base64 characters to represent z-scores (standard deviations from mean)
 * Each node gets a 2-character health score: raw + geo-corrected
 */

const BASE64_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+=";
const NORMAL_POSITION = 32; // 'W' character represents 0 standard deviations
const Z_SCORE_STEP = 0.1; // Each character represents 0.1 standard deviation

export class HealthScoreEncoder {
  private base64Chars = BASE64_CHARS;
  private normalPosition = NORMAL_POSITION;
  private zScoreStep = Z_SCORE_STEP;

  // Convert z-score to base64 character
  zScoreToBase64(zScore: number): string {
    // Clamp z-score to valid range (-3.2 to +3.1)
    const clampedZ = Math.max(-3.2, Math.min(3.1, zScore));
    
    // Calculate position (0-63)
    const position = Math.round((clampedZ / this.zScoreStep) + this.normalPosition);
    
    // Ensure position is within valid range
    const finalPosition = Math.max(0, Math.min(63, position));
    
    return this.base64Chars[finalPosition];
  }

  // Convert base64 character to z-score
  base64ToZScore(char: string): number {
    const position = this.base64Chars.indexOf(char);
    
    if (position === -1) {
      throw new Error(`Invalid base64 character: ${char}`);
    }
    
    return (position - this.normalPosition) * this.zScoreStep;
  }

  // Encode raw and geo-corrected z-scores into 2-character string
  encodeHealthScore(rawZScore: number, geoCorrectedZScore: number): string {
    const rawChar = this.zScoreToBase64(rawZScore);
    const geoChar = this.zScoreToBase64(geoCorrectedZScore);
    return rawChar + geoChar;
  }

  // Decode 2-character string into raw and geo-corrected z-scores
  decodeHealthScore(encodedScore: string): { raw: number; geoCorrected: number } {
    if (encodedScore.length !== 2) {
      throw new Error('Health score must be exactly 2 characters');
    }
    
    return {
      raw: this.base64ToZScore(encodedScore[0]),
      geoCorrected: this.base64ToZScore(encodedScore[1])
    };
  }

  // Helper to get human-readable description of z-score
  describeZScore(zScore: number): string {
    if (zScore < -2) return 'extremely poor';
    if (zScore < -1) return 'poor';
    if (zScore < -0.5) return 'below average';
    if (zScore < 0.5) return 'normal';
    if (zScore < 1) return 'above average';
    if (zScore < 2) return 'good';
    return 'excellent';
  }

  // Get numeric health score from z-score (0-100 scale)
  zScoreToPercent(zScore: number): number {
    // Convert z-score (-3 to +3) to 0-100 scale
    // -3 = 0%, 0 = 50%, +3 = 100%
    return Math.max(0, Math.min(100, Math.round(((zScore + 3) / 6) * 100)));
  }
}

// Statistics helper for calculating z-scores from latency data
export class LatencyStatistics {
  private windowSize: number;
  private measurements: Map<string, number[]>;

  constructor(windowSize = 100) {
    this.windowSize = windowSize;
    this.measurements = new Map();
  }

  // Add a latency measurement for a target node
  addMeasurement(targetNode: string, latency: number): void {
    if (!this.measurements.has(targetNode)) {
      this.measurements.set(targetNode, []);
    }
    
    const nodeMeasurements = this.measurements.get(targetNode)!;
    nodeMeasurements.push(latency);
    
    // Keep only the most recent measurements
    if (nodeMeasurements.length > this.windowSize) {
      nodeMeasurements.shift();
    }
  }

  // Calculate mean and standard deviation for a target node
  getStatistics(targetNode: string): { mean: number; stdDev: number; count: number } | null {
    const nodeMeasurements = this.measurements.get(targetNode);
    
    if (!nodeMeasurements || nodeMeasurements.length < 2) {
      return null;
    }
    
    // Calculate mean
    const mean = nodeMeasurements.reduce((sum, val) => sum + val, 0) / nodeMeasurements.length;
    
    // Calculate standard deviation
    const variance = nodeMeasurements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / nodeMeasurements.length;
    const stdDev = Math.sqrt(variance);
    
    return { mean, stdDev, count: nodeMeasurements.length };
  }

  // Calculate z-score for a new latency measurement
  calculateZScore(targetNode: string, latency: number): number {
    const stats = this.getStatistics(targetNode);
    
    if (!stats || stats.stdDev === 0) {
      return 0; // Return normal if insufficient data
    }
    
    return (latency - stats.mean) / stats.stdDev;
  }

  // Get all nodes with sufficient data
  getNodesWithData(minMeasurements = 10): string[] {
    const nodes: string[] = [];
    
    const entries = Array.from(this.measurements.entries());
    for (const [node, measurements] of entries) {
      if (measurements.length >= minMeasurements) {
        nodes.push(node);
      }
    }
    
    return nodes;
  }

  // Get global statistics across all nodes
  getGlobalStatistics(): { mean: number; stdDev: number } | null {
    const allMeasurements: number[] = [];
    
    const allValues = Array.from(this.measurements.values());
    for (const measurements of allValues) {
      allMeasurements.push(...measurements);
    }
    
    if (allMeasurements.length < 2) {
      return null;
    }
    
    const mean = allMeasurements.reduce((sum, val) => sum + val, 0) / allMeasurements.length;
    const variance = allMeasurements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / allMeasurements.length;
    
    return { mean, stdDev: Math.sqrt(variance) };
  }

  // Clear measurements for a specific node
  clearNode(targetNode: string): void {
    this.measurements.delete(targetNode);
  }
}

// Singleton instances
export const healthScoreEncoder = new HealthScoreEncoder();
export const latencyStats = new LatencyStatistics();
