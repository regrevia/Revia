export function generateDeterministicReplacements(
  source,
  { alphabet, count, positions, seed },
) {
  if (typeof source !== 'string' || !Number.isSafeInteger(count) || count < 0) {
    throw new TypeError('invalid deterministic replacement request')
  }
  if (!Array.isArray(positions) || positions.length === 0) {
    throw new TypeError('deterministic replacements require positions')
  }
  if (!Array.isArray(alphabet) || alphabet.length < 2) {
    throw new TypeError('deterministic replacements require an alphabet')
  }
  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position < 0 || position >= source.length) {
      throw new RangeError('deterministic replacement position is out of range')
    }
    if (source.charCodeAt(position) > 0x7f) {
      throw new TypeError('deterministic replacement positions must be ASCII')
    }
  }
  for (const character of alphabet) {
    if (
      typeof character !== 'string' ||
      character.length !== 1 ||
      character.charCodeAt(0) > 0x7f
    ) {
      throw new TypeError('deterministic replacement alphabet must be ASCII')
    }
  }

  const next = xorshift32(seed)
  const generated = []
  for (let index = 0; index < count; index += 1) {
    const offset = positions[next() % positions.length]
    const choices = alphabet.filter((character) => character !== source[offset])
    if (choices.length === 0) {
      throw new RangeError('replacement alphabet cannot change source byte')
    }
    const replacement = choices[next() % choices.length]
    generated.push({
      id: index,
      offset,
      replacement,
      source: source.slice(0, offset) + replacement + source.slice(offset + 1),
    })
  }
  return generated
}

function xorshift32(seed) {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError('deterministic replacement seed must be an integer')
  }
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}
