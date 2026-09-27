import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePlayerResponse} from '../app/lib/parse-player-response.mjs';

function playerResponse(text) {
  return {
    videoDetails: {title: text, shortDescription: text, lengthSeconds: '120'},
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {baseUrl: 'https://example.com/es', languageCode: 'es'},
          {
            baseUrl: 'https://example.com/en',
            languageCode: 'en',
            name: {runs: [{text}]},
          },
        ],
      },
    },
  };
}

for (const text of [
  'Ordinary video title',
  'JavaScript tutorial: }; inside a title',
  'Multiple }; delimiters }; and unmatched braces { {{ }',
  'Escaped quote "}; followed by more text',
  'Backslash before quote \\"}; and a trailing backslash \\',
  'Unicode \u2728 and newlines\n};\nremain string content',
]) {
  test(`preserves metadata and caption tracks: ${JSON.stringify(text)}`, () => {
    const expected = playerResponse(text);
    const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify(expected)}; var next = {"unrelated":true};</script>`;
    assert.deepEqual(parsePlayerResponse(html), expected);
  });
}

test('handles formatted nested JSON and whitespace before the terminator', () => {
  const expected = playerResponse('};');
  const html = `ytInitialPlayerResponse\n =\n ${JSON.stringify(expected, null, 2)}\n ;`;
  assert.deepEqual(parsePlayerResponse(html), expected);
});

test('handles even numbers of backslashes at the end of a string', () => {
  const expected = {path: 'ends in \\', ...playerResponse('};')};
  assert.deepEqual(
    parsePlayerResponse(`ytInitialPlayerResponse = ${JSON.stringify(expected)};`),
    expected,
  );
});

test('preserves responses without captions', () => {
  const expected = {videoDetails: {title: 'No captions };', lengthSeconds: '0'}};
  assert.deepEqual(
    parsePlayerResponse(`ytInitialPlayerResponse = ${JSON.stringify(expected)};`),
    expected,
  );
});

for (const html of [
  '<html>No player response</html>',
  'ytInitialPlayerResponse = null;',
  'ytInitialPlayerResponse = {"title":"unterminated };',
  'ytInitialPlayerResponse = {"nested":{"title":"};"};',
  'ytInitialPlayerResponse = {"title": invalid};',
  'ytInitialPlayerResponse = {"title":"bad escape \\q"};',
]) {
  test(`returns null for missing or malformed JSON: ${html}`, () => {
    assert.equal(parsePlayerResponse(html), null);
  });
}
