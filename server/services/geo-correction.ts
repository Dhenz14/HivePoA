/**
 * Geographic Latency Correction Module
 * Repurposed from SPK Network's trole/geoCorrection.js
 * 
 * Adjusts latency measurements based on expected geographic distances
 * This ensures CDN nodes aren't penalized for unavoidable network distance
 */

type DistanceCategory = 'same' | 'local' | 'continental' | 'intercontinental' | 'unknown';

export class GeoCorrection {
  // Expected baseline latencies between regions (in ms)
  private regionLatencies: Record<DistanceCategory, number> = {
    'same': 5,           // Same datacenter/city
    'local': 20,         // Same country/region
    'continental': 50,   // Same continent
    'intercontinental': 150,  // Different continents
    'unknown': 100       // Unknown distance
  };

  // Region groupings for distance estimation
  private continents: Record<string, string[]> = {
    'north-america': ['us', 'ca', 'mx', 'us-east', 'us-west', 'us-central'],
    'south-america': ['br', 'ar', 'cl', 'co', 've', 'pe'],
    'europe': ['gb', 'de', 'fr', 'nl', 'es', 'it', 'se', 'pl', 'eu-west', 'eu-central'],
    'asia': ['jp', 'cn', 'kr', 'sg', 'in', 'hk', 'tw', 'asia-pacific'],
    'africa': ['za', 'eg', 'ng', 'ke'],
    'oceania': ['au', 'nz']
  };

  // Multipliers for regional performance expectations
  private multipliers: Record<DistanceCategory, number> = {
    'same': 0.5,         // Expect very low latency
    'local': 0.7,        // Expect low latency
    'continental': 1.0,  // Normal expectations
    'intercontinental': 1.5,  // Higher latency acceptable
    'unknown': 1.0       // Default to normal
  };

  // Estimate distance category between two regions
  estimateDistanceCategory(region1: string | null, region2: string | null): DistanceCategory {
    if (!region1 || !region2 || region1 === 'unknown' || region2 === 'unknown') {
      return 'unknown';
    }

    const r1 = region1.toLowerCase();
    const r2 = region2.toLowerCase();

    // Same region
    if (r1 === r2) {
      return 'same';
    }

    // Find continents
    const continent1 = this.findContinent(r1);
    const continent2 = this.findContinent(r2);

    if (continent1 === continent2 && continent1 !== 'unknown') {
      // Check if they're in the same country
      if (this.isSameCountry(r1, r2)) {
        return 'local';
      }
      return 'continental';
    }

    return 'intercontinental';
  }

  private findContinent(region: string): string {
    for (const [continent, regions] of Object.entries(this.continents)) {
      if (regions.some(r => region.includes(r) || r.includes(region))) {
        return continent;
      }
    }
    return 'unknown';
  }

  private isSameCountry(region1: string, region2: string): boolean {
    const countryPrefixes = ['us-', 'eu-', 'asia-', 'ca-', 'au-'];
    
    for (const prefix of countryPrefixes) {
      if (region1.startsWith(prefix) && region2.startsWith(prefix)) {
        return true;
      }
    }
    
    return false;
  }

  // Get expected baseline latency for a distance category
  getExpectedLatency(distanceCategory: DistanceCategory): number {
    return this.regionLatencies[distanceCategory] || this.regionLatencies['intercontinental'];
  }

  // Calculate geo-corrected latency
  calculateGeoCorrectedLatency(actualLatency: number, sourceRegion: string | null, targetRegion: string | null): number {
    const distanceCategory = this.estimateDistanceCategory(sourceRegion, targetRegion);
    
    if (distanceCategory === 'unknown') {
      return actualLatency;
    }

    const expectedBaseline = this.getExpectedLatency(distanceCategory);
    const medianLatency = 50;
    const correction = expectedBaseline - medianLatency;
    
    // Apply correction but ensure we don't go below 1ms
    return Math.max(1, actualLatency - correction);
  }

  // Get multiplier for comparing latencies across regions
  getRegionalMultiplier(sourceRegion: string | null, targetRegion: string | null): number {
    const distanceCategory = this.estimateDistanceCategory(sourceRegion, targetRegion);
    return this.multipliers[distanceCategory] || 1.0;
  }

  // Advanced statistical geo correction
  calculateStatisticalGeoCorrection(
    actualLatency: number,
    sourceRegion: string | null,
    targetRegion: string | null,
    globalMean: number,
    globalStdDev: number
  ): number {
    const distanceCategory = this.estimateDistanceCategory(sourceRegion, targetRegion);
    const expectedBaseline = this.getExpectedLatency(distanceCategory);
    
    // Calculate expected z-score for this distance category
    const expectedZScore = (expectedBaseline - globalMean) / globalStdDev;
    
    // Calculate actual z-score
    const actualZScore = (actualLatency - globalMean) / globalStdDev;
    
    // Adjust z-score based on distance expectations
    const adjustedZScore = actualZScore - expectedZScore;
    
    // Convert back to latency
    const correctedLatency = globalMean + (adjustedZScore * globalStdDev);
    
    return Math.max(1, correctedLatency);
  }

  // Parse region code from various formats
  parseRegion(input: string): { region: string; country: string | null; continent: string } {
    const normalized = input.toLowerCase().trim();
    
    // Check if it matches a known region pattern
    for (const [continent, regions] of Object.entries(this.continents)) {
      for (const region of regions) {
        if (normalized === region || normalized.startsWith(region + '-') || normalized.includes(region)) {
          return {
            region: normalized,
            country: region.length === 2 ? region : null,
            continent
          };
        }
      }
    }
    
    return {
      region: normalized,
      country: null,
      continent: 'unknown'
    };
  }

  // Get all known regions
  getAllRegions(): string[] {
    const regions: string[] = [];
    for (const regionList of Object.values(this.continents)) {
      regions.push(...regionList);
    }
    return regions;
  }

  // Get continent name for display
  getContinentName(continent: string): string {
    const names: Record<string, string> = {
      'north-america': 'North America',
      'south-america': 'South America',
      'europe': 'Europe',
      'asia': 'Asia',
      'africa': 'Africa',
      'oceania': 'Oceania',
      'unknown': 'Unknown'
    };
    return names[continent] || 'Unknown';
  }
}

// Singleton instance
export const geoCorrection = new GeoCorrection();
