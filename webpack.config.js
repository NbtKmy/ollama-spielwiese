const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'development',
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
