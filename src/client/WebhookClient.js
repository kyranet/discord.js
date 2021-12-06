'use strict';

const { z } = require('zod');
const BaseClient = require('./BaseClient');
const { Error } = require('../errors');
const Webhook = require('../structures/Webhook');

const webhookClientDataPredicate = z
  .strictObject({ url: z.string().url() })
  .or(z.strictObject({ id: z.string().min(17), token: z.string().nonempty() }));

/**
 * The webhook client.
 * @implements {Webhook}
 * @extends {BaseClient}
 */
class WebhookClient extends BaseClient {
  /**
   * The data for the webhook client containing either an id and token or just a URL
   * @typedef {Object} WebhookClientData
   * @property {Snowflake} [id] The id of the webhook
   * @property {string} [token] The token of the webhook
   * @property {string} [url] The full URL for the webhook client
   */

  /**
   * @param {WebhookClientData} data The data of the webhook
   * @param {ClientOptions} [options] Options for the client
   */
  constructor(data, options) {
    super(options);
    Object.defineProperty(this, 'client', { value: this });
    let id, token;

    const resolved = webhookClientDataPredicate.parse(data);
    if ('url' in resolved) {
      const url = resolved.url.match(
        // eslint-disable-next-line no-useless-escape
        /^https?:\/\/(?:canary|ptb)?\.?discord\.com\/api\/webhooks(?:\/v[0-9]\d*)?\/([^\/]+)\/([^\/]+)/i,
      );

      if (!url || url.length <= 1) throw new Error('WEBHOOK_URL_INVALID');

      [, id, token] = url;
    } else {
      id = resolved.id;
      token = resolved.token;
    }

    this.id = id;
    Object.defineProperty(this, 'token', { value: token, writable: true, configurable: true });
  }

  // These are here only for documentation purposes - they are implemented by Webhook
  /* eslint-disable no-empty-function */
  send() {}
  sendSlackMessage() {}
  fetchMessage() {}
  edit() {}
  editMessage() {}
  delete() {}
  deleteMessage() {}
  get createdTimestamp() {}
  get createdAt() {}
  get url() {}
}

Webhook.applyToClass(WebhookClient);

module.exports = WebhookClient;
