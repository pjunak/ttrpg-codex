# Host delivery and interaction measurements

T29 evidence, September 16, 2026. This uses disposable synthetic data, not either
live campaign. It establishes a reproducible baseline and fixes a measured
transfer cost; it is not a physical-phone or field Web Vitals result.

## Method and reproducibility

From the host root, after installing its declared toolchain:

```console
npm --workspace @ttrpg-codex/frontend run build
node scripts/profile-campaign.mts current 3
```

The [harness](../../scripts/profile-campaign.mts) builds a temporary Go host,
creates records through real authorized transactions and removes its own data
directory afterward. Reports remain under ignored
`frontend/test-results/performance/`; no credentials or campaign prose are
included in those reports. Keep the machine free of concurrent build/test load.

The campaign has 1,800 characters, 400 map locations, 200 events and 900
relationships (3,300 records). Characters/locations contain repeated synthetic
prose, with public/DM visibility mixed. A generated 1,600 × 1,000 PNG supplies the
map. The text is deliberately repeatable and unusually compressible; its ratio
must not be presented as the expected ratio of a real campaign.

Three fresh browser contexts per profile measure cold Home, cached reload,
search, opening the result, map opening, two zoom-in actions, marker selection
and a pointer pan. Each action waits for its visible result and two animation
frames. These are automation wall times, including Playwright and rendering,
**not INP**. Map selection follows zooming into the initially dense marker grid.

| Profile | Configuration |
| --- | --- |
| Desktop | 1,440 × 1,000 CSS px; unthrottled localhost, CPU 1× |
| Phone | 390 × 844 CSS px with touch emulation; CPU 4× slowdown; 150 ms latency; 1.6 Mbps download / 750 kbps upload |
| Machine | Windows; Ryzen 7 9800X3D; Node 26.7.0; Chromium 151.0.7922.34 |
| Baseline | Host `94544bc`; app asset `codex-app-KFUXVN6-.js` |
| Comparison | Same frontend build and data; host HTTP compression patch on that revision |

Reports record machine/browser versions, source revision and dirtiness, build
asset hashes, raw identity/compressed HTTP body sizes, and browser resource
timings. The later session-recovery UI change is separate from this comparison.

The methodology follows the primary documentation for [Playwright CDP sessions](https://playwright.dev/docs/api/class-cdpsession),
[Chrome CPU/network emulation](https://developer.chrome.com/docs/devtools/performance/reference)
and the distinction between these lab actions and [INP](https://web.dev/articles/inp).
Emulation is relative to the development CPU, not a substitute for a real device.

## Observed result

All values below are medians in milliseconds, with the three-sample range.

| Action | Desktop baseline | Desktop compressed host | Phone baseline | Phone compressed host |
| --- | --- | --- | --- | --- |
| Cold Home | 293 (275–306) | 261 (241–273) | 21,627 (21,605–21,669) | 21,600 (21,541–21,643) |
| Cached reload | 149 (148–149) | 133 (131–149) | 12,963 (12,947–12,996) | 12,912 (12,909–12,947) |
| Search | 40 (39–40) | 39 (39–41) | 141 (127–142) | 138 (126–139) |
| Article | 100 (100–101) | 100 (99–100) | 201 (186–232) | 200 (182–201) |
| Map opening | 111 (106–201) | 118 (118–184) | 1,000 (999–1,018) | 1,053 (1,018–1,083) |
| Two zoom steps | 209 (199–212) | 183 (167–183) | 601 (527–665) | 610 (600–629) |
| Marker selection | 82 (81–83) | 83 (83–84) | 149 (139–200) | 152 (151–207) |
| Pan | 124 (123–124) | 123 (122–124) | 120 (114–166) | 132 (121–136) |

**Local measurement limitation:** a separate local HTTP probe confirmed that
responses sent with `Content-Encoding: gzip` reached Chromium as decoded bodies
with `X-Content-Encoding-Over-Network: gzip`. The browser then applied its
throttling to those decoded bodies. The harness now detects and reports this
condition. The almost unchanged phone load times cannot establish the actual
download-time benefit of compression. No local network/security configuration
was altered to obtain a better score.

Direct HTTP probes count the actual encoded bytes and verify that decompression
reproduces exactly the identity response:

| Response | Identity bytes | Gzip bytes |
| --- | ---: | ---: |
| Campaign dataset | 2,360,092 | 63,938 |
| Main application script | 1,200,429 | 350,943 |
| Shared script | 137,201 | 42,159 |
| Styles | 160,979 | 32,974 |
| Small entry script | 967 | 967 (kept as identity) |
| Total above | 3,859,668 | 490,981 |

This reduces these response bodies by **87.3%** for this fixture. Static text
alone falls by **71.5%**. Unthrottled campaign API read/JSON-parse samples were
57/54/53 ms before and 59/55/63 ms after; compression did not expose a material
server latency problem in this small run. Search/article interaction remained
much cheaper than transferring the original full dataset. No bundle splitting,
virtualization or changed search semantics was justified by these measurements.

## Delivery behavior and regression checks

The host compresses only the successfully role-projected campaign GET response
and eligible immutable JavaScript/CSS assets. Campaign responses remain
`no-store`; authentication secrets, event streams, media and backup archives
do not enter this compression path. Campaign gzip uses Go's fastest level;
static assets are compressed once at startup, bounded to 8 MiB per input and
32 MiB aggregate input, and retained only when smaller. Small/binary files use
the existing file handler.

Negotiation respects explicit exclusions, wildcard weights and identity
preferences. Both variants vary on Accept-Encoding; compressed assets have
their own strong validators. HEAD/conditional requests remain valid, and byte
ranges address the original uncompressed representation. These choices follow
[HTTP content negotiation and validators](https://www.rfc-editor.org/rfc/rfc9110.html#name-accept-encoding)
and [Go gzip semantics](https://pkg.go.dev/compress/gzip).

[HTTP regression tests](../../internal/transport/httpapi/compression_test.go)
decode real public/player/DM projections, compare them byte-for-byte, verify
private-record exclusion and no-store behavior, and exercise encoding refusal,
HEAD, validators, ranges, file types, missing paths and input bounds.

Repeat measurements with representative authored text and an unmodified network
path during authorized real-device/site acceptance. A measured transfer reduction
does not certify field INP, Safari/Firefox behavior or a particular phone's speed.
