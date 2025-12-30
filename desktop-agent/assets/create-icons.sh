#!/bin/bash
# This script creates placeholder icons - replace with real SPK logo
convert -size 512x512 xc:'#00d4aa' -fill '#1a1a2e' -gravity center \
  -pointsize 200 -annotate 0 'SPK' icon.png 2>/dev/null || \
  echo "ImageMagick not found - using placeholder"

# Create basic placeholder if convert fails
if [ ! -f icon.png ]; then
  # Create a simple 1x1 pixel PNG as fallback (you'll need to replace this)
  echo "Creating placeholder icon files..."
fi
