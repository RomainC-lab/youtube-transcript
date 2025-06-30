const RE_YOUTUBE =
  /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';
const RE_XML_TRANSCRIPT =
  /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

export class YoutubeTranscriptError extends Error {
  constructor(message) {
    super(`[YoutubeTranscript] 🚨 ${message}`);
  }
}

export class YoutubeTranscriptTooManyRequestError extends YoutubeTranscriptError {
  constructor() {
    super(
      'YouTube is receiving too many requests from this IP and now requires solving a captcha to continue'
    );
  }
}

export class YoutubeTranscriptVideoUnavailableError extends YoutubeTranscriptError {
  constructor(videoId: string) {
    super(`The video is no longer available (${videoId})`);
  }
}

export class YoutubeTranscriptDisabledError extends YoutubeTranscriptError {
  constructor(videoId: string) {
    super(`Transcript is disabled on this video (${videoId})`);
  }
}

export class YoutubeTranscriptNotAvailableError extends YoutubeTranscriptError {
  constructor(videoId: string) {
    super(`No transcripts are available for this video (${videoId})`);
  }
}

export class YoutubeTranscriptNotAvailableLanguageError extends YoutubeTranscriptError {
  constructor(lang: string, availableLangs: string[], videoId: string) {
    super(
      `No transcripts are available in ${lang} this video (${videoId}). Available languages: ${availableLangs.join(
        ', '
      )}`
    );
  }
}

export class YoutubeTranscriptEmptyError extends YoutubeTranscriptError {
  constructor(videoId: string, method: string) {
    super(
      `The transcript file URL returns an empty response using ${method} (${videoId})`
    );
  }
}

export interface TranscriptConfig {
  lang?: string;
}

export interface TranscriptResponse {
  text: string;
  duration: number;
  offset: number;
  lang?: string;
}

// 添加新的接口来包含视频元数据
export interface VideoMetadata {
  title?: string;
  description?: string;
  thumbnail?: any;
  lengthSeconds?: string;
  viewCount?: string;
}

export interface VideoTranscriptResponse {
  transcript: TranscriptResponse[];
  videoMetadata?: VideoMetadata;
}

/**
 * Class to retrieve transcript if exist
 */
export class YoutubeTranscript {
  /**
   * Fetch transcript from YTB Video
   * @param videoId Video url or video identifier
   * @param config Get transcript in a specific language ISO
   */
  public static async fetchTranscript(
    videoId: string,
    config?: TranscriptConfig
  ): Promise<VideoTranscriptResponse> {
    try {
      return await this.fetchTranscriptWithHtmlScraping(videoId, config);
    } catch (e) {
      if (e instanceof YoutubeTranscriptEmptyError) {
        return await this.fetchTranscriptWithInnerTube(videoId, config);
      } else {
        throw e;
      }
    }
  }

  /**
   * Fetch transcript from YTB Video using HTML scraping
   * @param videoId Video url or video identifier
   * @param config Get transcript in a specific language ISO
   */
  private static async fetchTranscriptWithHtmlScraping(
    videoId: string,
    config?: TranscriptConfig
  ): Promise<VideoTranscriptResponse> {
    const identifier = this.retrieveVideoId(videoId);
    const videoPageResponse = await fetch(
      `https://www.youtube.com/watch?v=${identifier}`,
      {
        headers: {
          ...(config?.lang && { 'Accept-Language': config.lang }),
          'User-Agent': USER_AGENT,
        },
      }
    );
    const videoPageBody = await videoPageResponse.text();

    const splittedHTML = videoPageBody.split('"captions":');

    if (splittedHTML.length <= 1) {
      if (videoPageBody.includes('class="g-recaptcha"')) {
        throw new YoutubeTranscriptTooManyRequestError();
      }
      if (!videoPageBody.includes('"playabilityStatus":')) {
        throw new YoutubeTranscriptVideoUnavailableError(videoId);
      }
      throw new YoutubeTranscriptDisabledError(videoId);
    }

    const captions = (() => {
      try {
        return JSON.parse(
          splittedHTML[1].split(',"videoDetails')[0].replace('\n', '')
        );
      } catch (e) {
        return undefined;
      }
    })()?.['playerCaptionsTracklistRenderer'];

    const processedTranscript = await this.processTranscriptFromCaptions(
      captions,
      videoId,
      config
    );

    if (!processedTranscript.length) {
      throw new YoutubeTranscriptEmptyError(videoId, 'HTML scraping');
    }

    return {
      transcript: processedTranscript,
      // HTML scraping 方法無法獲取詳細的視頻元數據
      videoMetadata: undefined,
    };
  }

  /**
   * Fetch transcript from YTB Video using InnerTube API
   * @param videoId Video url or video identifier
   * @param config Get transcript in a specific language ISO
   */
  private static async fetchTranscriptWithInnerTube(
    videoId: string,
    config?: TranscriptConfig
  ): Promise<VideoTranscriptResponse> {
    const identifier = this.retrieveVideoId(videoId);
    const options = {
      method: 'POST',
      headers: {
        ...(config?.lang && { 'Accept-Language': config.lang }),
        'Content-Type': 'application/json',
        Origin: 'https://www.youtube.com',
        Referer: `https://www.youtube.com/watch?v=${identifier}`,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20250312.04.00',
            userAgent: USER_AGENT,
          },
        },
        videoId: identifier,
      }),
    };

    const InnerTubeApiResponse = await fetch(
      'https://www.youtube.com/youtubei/v1/player',
      options
    );

    const {
      captions: { playerCaptionsTracklistRenderer: captions },
      videoDetails: {
        title,
        shortDescription,
        thumbnail,
        lengthSeconds,
        viewCount,
      },
    } = await InnerTubeApiResponse.json();

    const processedTranscript = await this.processTranscriptFromCaptions(
      captions,
      videoId,
      config
    );

    if (!processedTranscript.length) {
      throw new YoutubeTranscriptEmptyError(videoId, 'InnerTube API');
    }

    return {
      transcript: processedTranscript,
      videoMetadata: {
        title,
        description: shortDescription,
        thumbnail,
        lengthSeconds,
        viewCount,
      },
    };
  }

  /**
   * Process transcript from data captions
   * @param captions Data captions
   * @param videoId Video url or video identifier
   * @param config Get transcript in a specific language ISO
   */
  private static async processTranscriptFromCaptions(
    captions: any,
    videoId: string,
    config?: TranscriptConfig
  ): Promise<TranscriptResponse[]> {
    if (!captions) {
      throw new YoutubeTranscriptDisabledError(videoId);
    }

    if (!('captionTracks' in captions)) {
      throw new YoutubeTranscriptNotAvailableError(videoId);
    }

    if (
      config?.lang &&
      !captions.captionTracks.some(
        (track) => track.languageCode === config?.lang
      )
    ) {
      throw new YoutubeTranscriptNotAvailableLanguageError(
        config?.lang,
        captions.captionTracks.map((track) => track.languageCode),
        videoId
      );
    }

    const transcriptURL = (
      config?.lang
        ? captions.captionTracks.find(
            (track) => track.languageCode === config?.lang
          )
        : captions.captionTracks[0]
    ).baseUrl;

    const transcriptResponse = await fetch(transcriptURL, {
      headers: {
        ...(config?.lang && { 'Accept-Language': config.lang }),
        'User-Agent': USER_AGENT,
      },
    });
    if (!transcriptResponse.ok) {
      throw new YoutubeTranscriptNotAvailableError(videoId);
    }
    const transcriptBody = await transcriptResponse.text();
    const results = [...transcriptBody.matchAll(RE_XML_TRANSCRIPT)];
    return results.map((result) => ({
      text: result[3],
      duration: parseFloat(result[2]),
      offset: parseFloat(result[1]),
      lang: config?.lang ?? captions.captionTracks[0].languageCode,
    }));
  }

  /**
   * Retrieve video id from url or string
   * @param videoId video url or video id
   */
  private static retrieveVideoId(videoId: string) {
    if (videoId.length === 11) {
      return videoId;
    }
    const matchId = videoId.match(RE_YOUTUBE);
    if (matchId && matchId.length) {
      return matchId[1];
    }
    throw new YoutubeTranscriptError(
      'Impossible to retrieve Youtube video ID.'
    );
  }
}
