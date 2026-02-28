const path = require('path');

module.exports = {
  mode: 'production',
  entry: './src/main/index.ts',
  target: 'electron-main',
  output: {
    path: path.resolve(__dirname, '../dist/main'),
    filename: 'index.js',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  externals: {
    'electron': 'commonjs electron',
    'electron-store': 'commonjs electron-store',
    'ws': 'commonjs ws',
    'bufferutil': 'commonjs bufferutil',
    'utf-8-validate': 'commonjs utf-8-validate',
    '@hiveio/dhive': 'commonjs @hiveio/dhive',
  },
};
