# Pretext 0.0.8

This directory contains the browser ESM runtime files from
[`@chenglou/pretext`](https://github.com/chenglou/pretext), version `0.0.8`.
They are vendored because CodexHost deliberately ships browser-native modules
without a bundler and must remain usable offline.

Source package: `@chenglou/pretext@0.0.8`
Package integrity: `sha512-yqm2GMxnPI7VHcHwe84P8ZF0JK/2d2DMKPqMN+s95jQhwDMYYXKVFVJUMEaVWckQStdsjdLav/0Vu+d9YbtGxA==`

Only the files reachable from `dist/layout.js` are included. The unmodified
MIT license is in `LICENSE`. Project code must import the stable adapter at
`../../text-layout.js`, not this third-party API directly, except for the
adapter itself.
