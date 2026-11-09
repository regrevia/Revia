# Revia v1.0.0-rc.1 public trial kit

Install the accepted Darwin arm64 candidate outside the repository, then pass
its path as `REVIA_EXECUTABLE` when you run the command arrays recorded in
`trial-manifest.json` from a writable copy of this directory. The runner copies
that binary to `./bin/revia` in its own run directory; the repository's
`bin/revia` is the launcher for the current candidate, not this one.

The kit contains public fixtures and measured hashes only. It does not contain the candidate binary, compiler source, runtime source, credentials, or private repository metadata.
