import {json} from '@shopify/remix-oxygen';
import {Form, useActionData, useNavigation} from '@remix-run/react';

const MAX_TRANSCRIPT_CHARS = 12000;

export const meta = () => {
  return [{title: 'Viral Script Recreator | Analyze Any Video'}];
};

export async function action({request}) {
  const formData = await request.formData();
  const videoUrl = String(formData.get('videoUrl') || '').trim();

  if (!videoUrl) {
    return json({error: 'Please add a video URL to continue.'}, {status: 400});
  }

  try {
    const transcriptData = await getTranscriptFromUrl(videoUrl);

    if (!transcriptData.transcript) {
      return json(
        {
          error:
            'No transcript was found for this video. Try another URL with captions enabled.',
        },
        {status: 422},
      );
    }

    const analysis = buildViralAnalysis(transcriptData);

    return json({analysis, source: transcriptData});
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to process this video URL.',
      },
      {status: 500},
    );
  }
}

export default function Homepage() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === 'submitting';

  return (
    <main className="viral-lab">
      <section className="viral-lab-hero">
        <p className="eyebrow">Content Recreation App</p>
        <h1>Upload a video URL. Get the script + viral breakdown.</h1>
        <p>
          Paste a public YouTube link and this app will pull captions,
          summarize why the video worked, and generate a blueprint you can
          recreate.
        </p>
      </section>

      <section className="viral-lab-card">
        <Form method="post" className="viral-form">
          <label htmlFor="videoUrl">Video URL</label>
          <div className="viral-form-row">
            <input
              id="videoUrl"
              name="videoUrl"
              type="url"
              placeholder="https://www.youtube.com/watch?v=..."
              required
            />
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Analyzing…' : 'Analyze Video'}
            </button>
          </div>
        </Form>

        {actionData?.error && <p className="status-error">{actionData.error}</p>}
      </section>

      {actionData?.analysis && actionData?.source && (
        <section className="results-grid">
          <article className="result-card">
            <h2>Video Snapshot</h2>
            <ul>
              <li>
                <strong>Title:</strong> {actionData.source.title}
              </li>
              <li>
                <strong>Duration:</strong> {actionData.source.durationSeconds}s
              </li>
              <li>
                <strong>Words in script:</strong>{' '}
                {actionData.analysis.scriptMetrics.wordCount}
              </li>
              <li>
                <strong>Overall viral score:</strong>{' '}
                {actionData.analysis.viralScore}/100
              </li>
            </ul>
          </article>

          <article className="result-card">
            <h2>Why it likely went viral</h2>
            <ul>
              {actionData.analysis.viralSignals.map((signal) => (
                <li key={signal.title}>
                  <strong>{signal.title}:</strong> {signal.reason}
                </li>
              ))}
            </ul>
          </article>

          <article className="result-card">
            <h2>Recreation Blueprint</h2>
            <ol>
              {actionData.analysis.recreationBlueprint.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </article>

          <article className="result-card full-width">
            <h2>Full Script</h2>
            <p className="script-block">{actionData.source.transcript}</p>
          </article>
        </section>
      )}
    </main>
  );
}

async function getTranscriptFromUrl(videoUrl) {
  const videoId = extractYouTubeVideoId(videoUrl);

  if (!videoId) {
    throw new Error('Right now this prototype supports YouTube URLs only.');
  }

  const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
  if (!watchRes.ok) {
    throw new Error('Could not load the video page.');
  }

  const html = await watchRes.text();
  const playerResponse = parsePlayerResponse(html);
  const captions =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
    [];

  if (!captions.length) {
    return {
      title: playerResponse?.videoDetails?.title || 'Untitled video',
      durationSeconds: Number(playerResponse?.videoDetails?.lengthSeconds || 0),
      transcript: '',
    };
  }

  const englishTrack =
    captions.find((track) => track.languageCode?.startsWith('en')) ||
    captions[0];
  const captionsRes = await fetch(englishTrack.baseUrl);

  if (!captionsRes.ok) {
    throw new Error('Could not download captions from this video.');
  }

  const captionsXml = await captionsRes.text();
  const transcript = extractTranscriptFromXml(captionsXml).slice(
    0,
    MAX_TRANSCRIPT_CHARS,
  );

  return {
    title: playerResponse?.videoDetails?.title || 'Untitled video',
    durationSeconds: Number(playerResponse?.videoDetails?.lengthSeconds || 0),
    transcript,
  };
}

function extractYouTubeVideoId(videoUrl) {
  try {
    const url = new URL(videoUrl);

    if (url.hostname.includes('youtu.be')) {
      return url.pathname.replace('/', '').trim();
    }

    if (url.hostname.includes('youtube.com')) {
      return url.searchParams.get('v');
    }

    return null;
  } catch {
    return null;
  }
}

function parsePlayerResponse(html) {
  const directMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);

  if (!directMatch?.[1]) return null;

  try {
    return JSON.parse(directMatch[1]);
  } catch {
    return null;
  }
}

function extractTranscriptFromXml(xml) {
  const segments = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(
    (match) => decodeHtml(match[1]),
  );

  return segments.join(' ').replace(/\s+/g, ' ').trim();
}

function decodeHtml(text) {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function buildViralAnalysis(source) {
  const sentences = source.transcript
    .split(/[.!?]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const words = source.transcript.split(/\s+/).filter(Boolean);

  const hookWords = ['you', 'secret', 'truth', 'mistake', 'viral', 'stop', 'why'];
  const hookWordHits = words.filter((word) =>
    hookWords.includes(word.toLowerCase().replace(/[^a-z]/g, '')),
  ).length;

  const questionCount = (source.transcript.match(/\?/g) || []).length;
  const shortSentenceCount = sentences.filter(
    (sentence) => sentence.split(/\s+/).length <= 12,
  ).length;

  const viralScore = Math.min(
    100,
    Math.round(
      20 +
        (hookWordHits / Math.max(words.length, 1)) * 600 +
        questionCount * 4 +
        (shortSentenceCount / Math.max(sentences.length, 1)) * 30,
    ),
  );

  return {
    viralScore,
    scriptMetrics: {
      wordCount: words.length,
      sentenceCount: sentences.length,
      estimatedReadTimeSeconds: Math.round((words.length / 180) * 60),
    },
    viralSignals: [
      {
        title: 'Hook density',
        reason: `The script used ${hookWordHits} high-attention trigger words in ${words.length} words, which helps hold viewers early.`,
      },
      {
        title: 'Curiosity loops',
        reason: `There are ${questionCount} explicit questions that create open loops and keep viewers watching for answers.`,
      },
      {
        title: 'Punchy pacing',
        reason: `${shortSentenceCount} of ${sentences.length} sentences are short and mobile-friendly, which usually improves retention.`,
      },
    ],
    recreationBlueprint: [
      'Open with a 1-sentence promise in the first 2 seconds.',
      'State the outcome viewers will get before giving context.',
      'Use short sections with pattern interrupts every 8-12 seconds.',
      'Introduce at least 2 curiosity questions before your reveal.',
      'End with one clear CTA: comment, share, or try your version.',
    ],
  };
}
