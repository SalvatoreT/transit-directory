#!/usr/bin/env node
/**
 * Inspect a 511.org GTFS-realtime feed.
 *
 * Usage:
 *   node bin/inspect-feed.mjs <api_key> <agency> [feed_type]
 *
 * Arguments:
 *   api_key    - 511.org API key
 *   agency     - Agency code (e.g. RG, BA, SF)
 *   feed_type  - tripupdates (default), servicealerts, or vehiclepositions
 *
 * Examples:
 *   node bin/inspect-feed.mjs fc14fa0e-... RG
 *   node bin/inspect-feed.mjs fc14fa0e-... RG servicealerts
 */

import https from "node:https";
import protobuf from "protobufjs";

const [apiKey, agency, feedType = "tripupdates"] = process.argv.slice(2);

if (!apiKey || !agency) {
  console.error(
    "Usage: node bin/inspect-feed.mjs <api_key> <agency> [feed_type]",
  );
  process.exit(1);
}

const url = `https://api.511.org/transit/${feedType}?api_key=${apiKey}&agency=${agency}`;

// Minimal GTFS-realtime schema for decoding
const FeedMessage = protobuf.Type.fromJSON("FeedMessage", {
  fields: {
    header: { type: "FeedHeader", id: 1 },
    entity: { rule: "repeated", type: "FeedEntity", id: 2 },
  },
  nested: {
    FeedHeader: {
      fields: {
        gtfsRealtimeVersion: { type: "string", id: 1 },
        timestamp: { type: "uint64", id: 4 },
      },
    },
    FeedEntity: {
      fields: {
        id: { type: "string", id: 1 },
        tripUpdate: { type: "TripUpdate", id: 3 },
        alert: { type: "Alert", id: 5 },
      },
      nested: {
        TripUpdate: {
          fields: {
            trip: { type: "TripDescriptor", id: 1 },
            stopTimeUpdate: {
              rule: "repeated",
              type: "StopTimeUpdate",
              id: 2,
            },
            delay: { type: "int32", id: 5 },
          },
          nested: {
            TripDescriptor: {
              fields: {
                tripId: { type: "string", id: 1 },
                routeId: { type: "string", id: 5 },
                scheduleRelationship: { type: "int32", id: 4 },
              },
            },
            StopTimeUpdate: {
              fields: {
                stopSequence: { type: "uint32", id: 1 },
                arrival: { type: "StopTimeEvent", id: 2 },
                departure: { type: "StopTimeEvent", id: 3 },
                stopId: { type: "string", id: 4 },
              },
              nested: {
                StopTimeEvent: {
                  fields: {
                    delay: { type: "int32", id: 1 },
                    time: { type: "int64", id: 2 },
                  },
                },
              },
            },
          },
        },
        Alert: {
          fields: {
            activePeriod: { rule: "repeated", type: "TimeRange", id: 1 },
            informedEntity: {
              rule: "repeated",
              type: "EntitySelector",
              id: 5,
            },
            headerText: { type: "TranslatedString", id: 10 },
            descriptionText: { type: "TranslatedString", id: 11 },
            cause: { type: "int32", id: 6 },
            effect: { type: "int32", id: 7 },
          },
          nested: {
            TimeRange: {
              fields: {
                start: { type: "uint64", id: 1 },
                end: { type: "uint64", id: 2 },
              },
            },
            EntitySelector: {
              fields: {
                agencyId: { type: "string", id: 1 },
                routeId: { type: "string", id: 2 },
                stopId: { type: "string", id: 4 },
                trip: { type: "TripDescriptor", id: 3 },
              },
              nested: {
                TripDescriptor: {
                  fields: { tripId: { type: "string", id: 1 } },
                },
              },
            },
            TranslatedString: {
              fields: {
                translation: { rule: "repeated", type: "Translation", id: 1 },
              },
              nested: {
                Translation: {
                  fields: {
                    text: { type: "string", id: 1 },
                    language: { type: "string", id: 2 },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

function fetch511(feedUrl) {
  return new Promise((resolve, reject) => {
    https.get(feedUrl, (res) => {
      const headers = {
        rateLimitLimit: res.headers["ratelimit-limit"],
        rateLimitRemaining: res.headers["ratelimit-remaining"],
      };
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ buf: Buffer.concat(chunks), headers }));
      res.on("error", reject);
    });
  });
}

const { buf, headers } = await fetch511(url);
const msg = FeedMessage.decode(new Uint8Array(buf));

console.log(`Feed: ${feedType} | Agency: ${agency}`);
console.log(
  `Rate limit: ${headers.rateLimitRemaining}/${headers.rateLimitLimit}`,
);
console.log(`Header timestamp: ${msg.header?.timestamp}`);
console.log(`Total entities: ${msg.entity?.length ?? 0}`);
console.log();

if (feedType === "tripupdates") {
  // Group by agency prefix
  const byPrefix = {};
  for (const e of msg.entity || []) {
    const tid = e.tripUpdate?.trip?.tripId;
    if (!tid) continue;
    const colonIdx = tid.indexOf(":");
    const prefix = colonIdx >= 0 ? tid.substring(0, colonIdx) : "(none)";
    if (!byPrefix[prefix]) byPrefix[prefix] = { count: 0, samples: [] };
    byPrefix[prefix].count++;
    if (byPrefix[prefix].samples.length < 3) byPrefix[prefix].samples.push(tid);
  }
  console.log("Trip IDs by agency prefix:");
  for (const [prefix, data] of Object.entries(byPrefix).sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    console.log(
      `  ${prefix}: ${data.count} trips  (e.g. ${data.samples.join(", ")})`,
    );
  }
} else if (feedType === "servicealerts") {
  for (const e of (msg.entity || []).slice(0, 10)) {
    const a = e.alert;
    const header = a?.headerText?.translation?.[0]?.text || "(no header)";
    const agencies = (a?.informedEntity || [])
      .map((ie) => ie.agencyId)
      .filter(Boolean);
    console.log(`  [${e.id}] ${header}`);
    console.log(`    agencies: ${agencies.join(", ") || "(none)"}`);
  }
  if (msg.entity?.length > 10) {
    console.log(`  ... and ${msg.entity.length - 10} more`);
  }
}
