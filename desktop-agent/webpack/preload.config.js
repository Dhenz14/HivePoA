const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/main/preload.ts',
  target: 'electron-preload',
  output: {
    path: path.resolve(__dirname, '../dist/main'),
    filename: 'preload.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: path.resolve(__dirname, '../tsconfig.json'),
            transpileOnly: true,
          },
        },
        include: [path.resolve(__dirname, '../src')],
      },
    ],
  },
};
