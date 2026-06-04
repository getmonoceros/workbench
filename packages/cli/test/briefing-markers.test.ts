import { describe, expect, it } from 'vitest';
import {
  MARKER_BEGIN,
  MARKER_END,
  replaceMarkerBlock,
  wrapWithMarkers,
} from '../src/briefing/markers.js';

describe('briefing markers', () => {
  describe('wrapWithMarkers', () => {
    it('emits begin/end markers around the generated block and a user-notes footer', () => {
      const out = wrapWithMarkers('# Hello\n\nbody.');
      expect(out).toContain(MARKER_BEGIN);
      expect(out).toContain(MARKER_END);
      const beginIdx = out.indexOf(MARKER_BEGIN);
      const endIdx = out.indexOf(MARKER_END);
      expect(beginIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(beginIdx);
      // Generated body lands between the markers.
      expect(out.slice(beginIdx, endIdx)).toContain('# Hello');
      expect(out.slice(beginIdx, endIdx)).toContain('body.');
      // User-notes section lives outside (below) the end marker.
      expect(out.slice(endIdx)).toContain('My own notes');
    });

    it('trims trailing newlines from the generated block', () => {
      const out = wrapWithMarkers('body\n\n\n');
      // No `body\n\n\n` immediately followed by markers/whitespace —
      // the wrap canonicalises spacing.
      expect(out).not.toContain('body\n\n\n\n');
    });
  });

  describe('replaceMarkerBlock', () => {
    it('replaces only the content between markers, preserving user notes', () => {
      const existing = [
        '<!-- monoceros:begin -->',
        '',
        'OLD BLOCK',
        '',
        '<!-- monoceros:end -->',
        '',
        '## My own notes',
        '',
        '- remember to run migrations',
      ].join('\n');
      const out = replaceMarkerBlock(existing, 'NEW BLOCK');
      expect(out).not.toBeNull();
      expect(out!).not.toContain('OLD BLOCK');
      expect(out!).toContain('NEW BLOCK');
      // User notes survive untouched.
      expect(out!).toContain('- remember to run migrations');
    });

    it('returns null when either marker is missing', () => {
      expect(replaceMarkerBlock('no markers at all', 'X')).toBeNull();
      expect(
        replaceMarkerBlock('<!-- monoceros:begin -->\nonly begin', 'X'),
      ).toBeNull();
      expect(
        replaceMarkerBlock('<!-- monoceros:end -->\nonly end', 'X'),
      ).toBeNull();
    });

    it('returns null when end marker appears before begin', () => {
      const flipped = [
        '<!-- monoceros:end -->',
        'wat',
        '<!-- monoceros:begin -->',
      ].join('\n');
      expect(replaceMarkerBlock(flipped, 'X')).toBeNull();
    });
  });
});
