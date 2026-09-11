// Web Push: VAPID keys, subscription store, broadcast, and the notification
// history feed shown in the PWA's Feed tab.

import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const FEED_LIMIT = 200;

export class PushService {
  constructor(dataDir, vapidSubject) {
    this.subsFile = path.join(dataDir, 'subscriptions.json');
    this.feedFile = path.join(dataDir, 'feed.json');
    const vapidFile = path.join(dataDir, 'vapid.json');

    let vapid = readJson(vapidFile, null);
    if (!vapid || !vapid.publicKey || !vapid.privateKey) {
      vapid = webpush.generateVAPIDKeys();
      writeJson(vapidFile, vapid);
    }
    webpush.setVapidDetails(vapidSubject, vapid.publicKey, vapid.privateKey);
    this.publicKey = vapid.publicKey;

    this.subscriptions = readJson(this.subsFile, []);
    this.feed = readJson(this.feedFile, []);
  }

  subscribe(sub) {
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    this.subscriptions.push(sub);
    writeJson(this.subsFile, this.subscriptions);
    return this.subscriptions.length;
  }

  unsubscribe(endpoint) {
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    writeJson(this.subsFile, this.subscriptions);
    return this.subscriptions.length;
  }

  async notify({ title, body, silent = false, tag, url }, { broadcast = true } = {}) {
    const payload = {
      title: String(title || 'cmux'),
      body: String(body || ''),
      silent: Boolean(silent),
      tag: tag ? String(tag) : undefined,
      url: url ? String(url) : '/',
    };
    this.feed.unshift({ ts: Date.now(), title: payload.title, body: payload.body, silent: payload.silent, url: payload.url });
    this.feed = this.feed.slice(0, FEED_LIMIT);
    writeJson(this.feedFile, this.feed);
    // Category muted in Settings: keep the feed record, skip the phone push.
    if (!broadcast) return { sent: 0, pruned: 0, failed: 0 };

    const body_ = JSON.stringify(payload);
    let sent = 0;
    let pruned = 0;
    let failed = 0;
    const keep = [];
    for (const sub of this.subscriptions) {
      try {
        await webpush.sendNotification(sub, body_, { TTL: 3600, urgency: payload.silent ? 'normal' : 'high' });
        sent += 1;
        keep.push(sub);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) pruned += 1;
        else {
          failed += 1;
          keep.push(sub);
          console.error('push failed:', err.statusCode || err.message);
        }
      }
    }
    if (pruned) {
      this.subscriptions = keep;
      writeJson(this.subsFile, this.subscriptions);
    }
    return { sent, pruned, failed };
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
