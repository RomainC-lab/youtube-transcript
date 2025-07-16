import { YoutubeTranscript } from '../dist/youtube-transcript.common.js';

(async () => {
    console.log(await YoutubeTranscript.fetchTranscript(process.argv[2]));
})();
