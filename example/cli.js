const { YoutubeTranscript } = require('../dist/youtube-transcript.common.js');
YoutubeTranscript.fetchTranscript('dQw4w9WgXcQ')
  .then(console.log)
  .catch(console.error);
