const CopyWebpackPlugin = require('copy-webpack-plugin');
const LicenseWebpackPlugin = require('license-webpack-plugin').LicenseWebpackPlugin;
const path = require('path');
const webpack = require('webpack');

module.exports = (env = {}, argv) => ({
  output: {
    clean: true,
    path: path.resolve(__dirname, '..', 'build'),
    filename: '[name].js'
  },
  entry: {
    'background_scripts/laboratory': path.resolve(__dirname, '..', 'src', 'background_scripts', 'laboratory.js'),
    'popup/popup': path.resolve(__dirname, '..', 'src', 'popup', 'popup.js')
  },
  mode: argv.mode || 'development',
  devtool: argv.mode === 'production' ? undefined : 'source-map',
  module: {
    rules: [
      {
        test: /\.js$/,
        include: path.resolve(__dirname, '..', 'src'),
        use: [{
          loader: 'babel-loader',
          options: {
            babelrc: false,
            presets: [
              ['@babel/preset-env', {
                'targets': {
                  'firefox': 57
                },
                'shippedProposals': true
              }]
            ]
          }
        }]
      }
    ]
  },
  plugins: [
    new CopyWebpackPlugin({ patterns: [
      {
        from: env.target === 'firefox' ? 'src/manifest.firefox.json' : 'src/manifest.json',
        to: 'manifest.json'
      },
      {
        from: 'LICENSE.md'
      },
      {
        from: 'src/popup/*.+(html|css|woff2)',
        to: 'popup/[name][ext]'
      },
      {
        from: 'src/icons/*.png',
        to: 'icons/[name][ext]'
      },
      {
        from: 'node_modules/bootstrap/dist/css/bootstrap.min.css',
        to: 'popup/',
      },
      ...['desktop-download', 'pencil', 'copy', 'alert', 'trash'].map(icon => ({
        from: `node_modules/@primer/octicons/build/svg/${icon}-16.svg`,
        to: 'popup/octicons/[name][ext]'
      })),
      {
        from: 'node_modules/@primer/octicons/LICENSE',
        to: 'popup/octicons/LICENSE.txt'
      },
      {
        from: 'src/content_scripts/*.js',
        to: 'content_scripts/[name][ext]'
      }
    ] }),
    new LicenseWebpackPlugin(
      {
        pattern: /.*/,
        outputFilename: '[name].license.txt'
      }
    ),
    new webpack.ProvidePlugin({
      jQuery: 'jquery',
      $: 'jquery'   
    })
  ]
});
