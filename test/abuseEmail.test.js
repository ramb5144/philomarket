import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEmail } from '../server/abuseEmail.js';

test('case and whitespace collapse', () => {
  assert.equal(canonicalEmail('  Jax@School.EDU '), 'jax@school.edu');
});

test('gmail dots, plus tags, and googlemail collapse to one mailbox', () => {
  const variants = ['jax.smith@gmail.com', 'JaxSmith+alt1@gmail.com', 'j.a.x.s.m.i.t.h+x@googlemail.com', 'jaxsmith@GMAIL.com'];
  for (const v of variants) assert.equal(canonicalEmail(v), 'jaxsmith@gmail.com', v);
});

test('plus tags are stripped on non-gmail domains but dots are kept', () => {
  assert.equal(canonicalEmail('vedant+burner@school.edu'), 'vedant@school.edu');
  assert.equal(canonicalEmail('v.edant@school.edu'), 'v.edant@school.edu');
  assert.notEqual(canonicalEmail('v.edant@school.edu'), canonicalEmail('vedant@school.edu'));
});

test('distinct mailboxes stay distinct', () => {
  assert.notEqual(canonicalEmail('jax@gmail.com'), canonicalEmail('jax2@gmail.com'));
  assert.notEqual(canonicalEmail('jax@gmail.com'), canonicalEmail('jax@school.edu'));
});

test('degenerate input is not collapsed to a shared key', () => {
  assert.equal(canonicalEmail(undefined), '');
  assert.equal(canonicalEmail(42), '');
  assert.equal(canonicalEmail('+@gmail.com'), '+@gmail.com');
  assert.equal(canonicalEmail('...@gmail.com'), '...@gmail.com');
  assert.equal(canonicalEmail('no-at-sign'), 'no-at-sign');
  assert.equal(canonicalEmail('trailing@gmail.com.'), 'trailing@gmail.com');
});
