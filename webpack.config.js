const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'production',
  entry: {
    renderer: './src/renderer.js',
  },
  output: {
    path: path.resolve(__dirname, 'build'),
    filename: '[name].js',
  },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader', 'postcss-loader'],
      },
    ],
  },
  resolve: {
    fallback: {
      fs: false,
      path: false,
      crypto: false,
      stream: false,
      url: false,
      util: false,
      zlib: false,
      net: false,
      http: false,
      https: false,
      querystring: false
     },
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './public/index.html',
      filename: 'index.html',
      chunks: ['renderer'],
    }),
    new CopyWebpackPlugin({
        patterns: [
          { from: 'public/style.css', to: 'style.css' }, 
        ],
    }),
  ],
  externals: {
    'pdfjs-dist': 'commonjs2 pdfjs-dist',
  }
};
