import { describe, expect, it } from 'vitest';
import { compareXLocation, toSafeXLocation } from './xResearchIdentity';

describe('X location identity', () => {
  // Losing one coordinate must not erase independent facts from other coordinates.
  it('locationRelationsKeepIndependentFacts', () => {
    expect(compareXLocation('https://x.com/a/status/123', 'https://x.com/a/status/123')).toEqual({ origin: 'same', path: 'same', postId: 'same', query: 'unknown', product: 'unknown', fragment: 'unknown' });
    expect(compareXLocation('https://x.com/a/status/123', 'https://x.com/i/web/status/123')).toMatchObject({ origin: 'same', path: 'different', postId: 'same' });
    expect(compareXLocation('https://x.com/a/status/123', 'https://twitter.com/a/status/123')).toMatchObject({ origin: 'different', path: 'same', postId: 'same' });
    expect(compareXLocation('https://x.com/a/status/123', 'https://x.com/a/status/456')).toMatchObject({ origin: 'same', path: 'different', postId: 'different' });
    const location = 'https://x.com/search?q=paper&f=live#result';
    expect(compareXLocation(location, 'https://x.com/search?f=live&q=paper#result')).toMatchObject({ origin: 'same', path: 'same', query: 'same', product: 'same', fragment: 'same' });
    expect(compareXLocation(location, 'https://x.com/search?q=other&f=live#result')).toMatchObject({ query: 'different', product: 'same', fragment: 'same' });
    expect(compareXLocation(location, 'https://x.com/search?q=paper&f=top#result')).toMatchObject({ query: 'same', product: 'different', fragment: 'same' });
    expect(compareXLocation(location, 'https://x.com/search?q=paper&f=live#other')).toMatchObject({ query: 'same', product: 'same', fragment: 'different' });
    expect(compareXLocation(location, 'https://x.com/search?q=paper')).toMatchObject({ query: 'same', product: 'unknown', fragment: 'unknown' });
    expect(compareXLocation(location, 'https://x.com/search?q=paper&q=other&f=live')).toMatchObject({ query: 'unknown', product: 'same' });
    expect(compareXLocation(location, 'invalid')).toEqual({ origin: 'unknown', path: 'unknown', postId: 'unknown', query: 'unknown', product: 'unknown', fragment: 'unknown' });
  });

  it('redactsSensitiveLocationWithoutInventingEquality', () => {
    expect(toSafeXLocation('https://x.com/a/status/123')).toEqual({ origin: 'https://x.com', path: '/a/status/123', q: null, f: null, fragment: null, redacted: false });
    const first = 'https://user:secret@x.com/i/flow/login?token=one#private-one';
    const second = 'https://other:different@x.com/i/flow/login?token=two#private-two';
    expect(toSafeXLocation(first)).toEqual({ origin: 'https://x.com', path: null, q: null, f: null, fragment: null, redacted: true });
    expect(toSafeXLocation(second)).toEqual(toSafeXLocation(first));
    expect(compareXLocation(first, second)).toMatchObject({ origin: 'same', path: 'same', fragment: 'different', postId: 'unknown' });
    expect(toSafeXLocation('https://x.com/search?q=paper&f=live&token=secret')).toEqual({ origin: 'https://x.com', path: '/search', q: 'paper', f: 'live', fragment: null, redacted: true });
    expect(toSafeXLocation('https://evil.com/private?token=secret')).toEqual({ origin: null, path: null, q: null, f: null, fragment: null, redacted: true });
    expect(toSafeXLocation('invalid')).toEqual({ origin: null, path: null, q: null, f: null, fragment: null, redacted: true });
  });
});
