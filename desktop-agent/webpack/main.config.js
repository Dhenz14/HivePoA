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
    extensions: ['.ts', '.js', '.json'],
    alias: {
      // Map the server's shared/schema import to SQLite schema for desktop agent
      '@shared': path.resolve(__dirname, '../../shared'),
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: {
            // Use the desktop agent's tsconfig
            configFile: path.resolve(__dirname, '../tsconfig.json'),
            transpileOnly: true,
          },
        },
        // Include desktop agent src, server code, and shared code
        include: [
          path.resolve(__dirname, '../src'),
          path.resolve(__dirname, '../../server'),
          path.resolve(__dirname, '../../shared'),
        ],
      },
    ],
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  externals: {
    // Electron + native modules — must remain external (not bundled)
    'electron': 'commonjs electron',
    'electron-store': 'commonjs electron-store',
    'ws': 'commonjs ws',
    'bufferutil': 'commonjs bufferutil',
    'utf-8-validate': 'commonjs utf-8-validate',
    '@hiveio/dhive': 'commonjs @hiveio/dhive',

    // SQLite native module — must be external for Electron rebuild
    'better-sqlite3': 'commonjs better-sqlite3',

    // Logging — pino uses worker threads which don't bundle well
    'pino': 'commonjs pino',
    'pino-pretty': 'commonjs pino-pretty',

    // PostgreSQL — not used in desktop agent but imported transitively by server/db.ts
    'pg': 'commonjs pg',

    // Express session store — not needed in desktop agent (uses SQLite sessions)
    'connect-pg-simple': 'commonjs connect-pg-simple',
  },
};
