'use strict';

const { Collection } = require('@discordjs/collection');
const { z } = require('zod');
const BaseClient = require('./BaseClient');
const ActionsManager = require('./actions/ActionsManager');
const ClientVoiceManager = require('./voice/ClientVoiceManager');
const WebSocketManager = require('./websocket/WebSocketManager');
const { Error, TypeError } = require('../errors');
const BaseGuildEmojiManager = require('../managers/BaseGuildEmojiManager');
const ChannelManager = require('../managers/ChannelManager');
const GuildManager = require('../managers/GuildManager');
const UserManager = require('../managers/UserManager');
const ShardClientUtil = require('../sharding/ShardClientUtil');
const ClientPresence = require('../structures/ClientPresence');
const GuildPreview = require('../structures/GuildPreview');
const GuildTemplate = require('../structures/GuildTemplate');
const Invite = require('../structures/Invite');
const Sticker = require('../structures/Sticker');
const StickerPack = require('../structures/StickerPack');
const VoiceRegion = require('../structures/VoiceRegion');
const Webhook = require('../structures/Webhook');
const Widget = require('../structures/Widget');
const { Events, InviteScopes, Status } = require('../util/Constants');
const DataResolver = require('../util/DataResolver');
const Intents = require('../util/Intents');
const Options = require('../util/Options');
const Permissions = require('../util/Permissions');

const stringPredicate = z.string().nonempty();
const clientOptionsPredicate = z.object({
  shards: z
    .number()
    .int()
    .positive()
    .or(z.number().int().positive().array().nonempty())
    .or(z.literal('auto'))
    .default('auto'),
  shardCount: z.number().int().gte(1).default(1),
  makeCache: z.function().default(() => Options.cacheWithLimits(Options.defaultMakeCacheSettings)),
  allowedMentions: z
    .strictObject({
      parse: z
        .union([z.literal('roles'), z.literal('users'), z.literal('everyone')])
        .array()
        .optional(),
      roles: z.string().min(17).array().optional(),
      users: z.string().min(17).array().optional(),
      repliedUser: z.boolean().optional(),
    })
    .default({}),
  invalidRequestWarningInterval: z.number().int().gt(0).default(0),
  partials: stringPredicate.array().default([]),
  restWsBridgeTimeout: z.number().int().default(5_000),
  restTimeOffset: z.number().int().positive().default(500),
  restRequestTimeout: z.number().int().default(15_000),
  restGlobalRateLimit: z.number().int().default(0),
  restSweepInterval: z.number().int().default(60),
  retryLimit: z.number().int().default(1),
  failIfNotExists: z.boolean().default(true),
  userAgentSuffix: stringPredicate.array().default([]),
  presence: z.strictObject({}).default({}),
  intents: z.any().transform(Intents.resolve),
  ws: z.strictObject({
    large_threshold: z.number().int().default(50),
    compress: z.boolean().default(false),
    properties: z.strictObject({
      $os: z.string().default(process.platform),
      $browser: z.string().default('discord.js'),
      $device: z.string().default('discord.js'),
    }),
    version: z.number().int().default(9),
  }),
  http: z.strictObject({
    agent: z.object({ keepAlive: z.never() }),
    api: stringPredicate.url().default('https://discord.com/api'),
    version: z.number().int().default(9),
    host: stringPredicate.url().optional(),
    cdn: stringPredicate.url().default('https://cdn.discordapp.com'),
    invite: stringPredicate.url().default('https://discord.gg'),
    template: stringPredicate.url().default('https://discord.new'),
    headers: z.record(stringPredicate, stringPredicate),
  }),
  rejectOnRateLimit: stringPredicate.or(z.function()),
});
const invitePredicate = z.strictObject({
  scopes: z
    .union(InviteScopes.map(scope => z.literal(scope)))
    .array()
    .refine(scopes =>
      scopes.some(scope => ['bot', 'applications.commands'].includes(scope), { message: 'INVITE_MISSING_SCOPES' }),
    ),
  permissions: z.any().optional().transform(Permissions.resolve),
  disableGuildSelect: z.boolean().default(false),
  guild: z.any().default(null),
});

/**
 * The main hub for interacting with the Discord API, and the starting point for any bot.
 * @extends {BaseClient}
 */
class Client extends BaseClient {
  /**
   * @param {ClientOptions} options Options for the client
   */
  constructor(options) {
    super(clientOptionsPredicate.parse(options));

    const data = require('node:worker_threads').workerData ?? process.env;
    const defaults = Options.createDefault();

    if (this.options.shards === defaults.shards) {
      if ('SHARDS' in data) {
        this.options.shards = JSON.parse(data.SHARDS);
      }
    }

    if (this.options.shardCount === defaults.shardCount) {
      if ('SHARD_COUNT' in data) {
        this.options.shardCount = Number(data.SHARD_COUNT);
      } else if (Array.isArray(this.options.shards)) {
        this.options.shardCount = this.options.shards.length;
      }
    }

    const typeofShards = typeof this.options.shards;

    if (typeofShards === 'undefined' && typeof this.options.shardCount === 'number') {
      this.options.shards = Array.from({ length: this.options.shardCount }, (_, i) => i);
    }

    if (typeofShards === 'number') this.options.shards = [this.options.shards];

    if (Array.isArray(this.options.shards)) {
      this.options.shards = [
        ...new Set(
          this.options.shards.filter(item => !isNaN(item) && item >= 0 && item < Infinity && item === (item | 0)),
        ),
      ];
    }

    /**
     * Functions called when a cache is garbage collected or the Client is destroyed
     * @type {Set<Function>}
     * @private
     */
    this._cleanups = new Set();

    /**
     * The finalizers used to cleanup items.
     * @type {FinalizationRegistry}
     * @private
     */
    this._finalizers = new FinalizationRegistry(this._finalize.bind(this));

    /**
     * The WebSocket manager of the client
     * @type {WebSocketManager}
     */
    this.ws = new WebSocketManager(this);

    /**
     * The action manager of the client
     * @type {ActionsManager}
     * @private
     */
    this.actions = new ActionsManager(this);

    /**
     * The voice manager of the client
     * @type {ClientVoiceManager}
     */
    this.voice = new ClientVoiceManager(this);

    /**
     * Shard helpers for the client (only if the process was spawned from a {@link ShardingManager})
     * @type {?ShardClientUtil}
     */
    this.shard = process.env.SHARDING_MANAGER
      ? ShardClientUtil.singleton(this, process.env.SHARDING_MANAGER_MODE)
      : null;

    /**
     * All of the {@link User} objects that have been cached at any point, mapped by their ids
     * @type {UserManager}
     */
    this.users = new UserManager(this);

    /**
     * All of the guilds the client is currently handling, mapped by their ids -
     * as long as sharding isn't being used, this will be *every* guild the bot is a member of
     * @type {GuildManager}
     */
    this.guilds = new GuildManager(this);

    /**
     * All of the {@link Channel}s that the client is currently handling, mapped by their ids -
     * as long as sharding isn't being used, this will be *every* channel in *every* guild the bot
     * is a member of. Note that DM channels will not be initially cached, and thus not be present
     * in the Manager without their explicit fetching or use.
     * @type {ChannelManager}
     */
    this.channels = new ChannelManager(this);

    /**
     * The presence of the Client
     * @private
     * @type {ClientPresence}
     */
    this.presence = new ClientPresence(this, this.options.presence);

    Object.defineProperty(this, 'token', { writable: true });
    if (!this.token && 'DISCORD_TOKEN' in process.env) {
      /**
       * Authorization token for the logged in bot.
       * If present, this defaults to `process.env.DISCORD_TOKEN` when instantiating the client
       * <warn>This should be kept private at all times.</warn>
       * @type {?string}
       */
      this.token = process.env.DISCORD_TOKEN;
    } else {
      this.token = null;
    }

    /**
     * User that the client is logged in as
     * @type {?ClientUser}
     */
    this.user = null;

    /**
     * The application of this bot
     * @type {?ClientApplication}
     */
    this.application = null;

    /**
     * Time at which the client was last regarded as being in the `READY` state
     * (each time the client disconnects and successfully reconnects, this will be overwritten)
     * @type {?Date}
     */
    this.readyAt = null;

    if (this.options.messageSweepInterval > 0) {
      process.emitWarning(
        'The message sweeping client options are deprecated, use the makeCache option with LimitedCollection instead.',
        'DeprecationWarning',
      );
      this.sweepMessageInterval = setInterval(
        this.sweepMessages.bind(this),
        this.options.messageSweepInterval * 1_000,
      ).unref();
    }
  }

  /**
   * All custom emojis that the client has access to, mapped by their ids
   * @type {BaseGuildEmojiManager}
   * @readonly
   */
  get emojis() {
    const emojis = new BaseGuildEmojiManager(this);
    for (const guild of this.guilds.cache.values()) {
      if (guild.available) for (const emoji of guild.emojis.cache.values()) emojis.cache.set(emoji.id, emoji);
    }
    return emojis;
  }

  /**
   * Timestamp of the time the client was last `READY` at
   * @type {?number}
   * @readonly
   */
  get readyTimestamp() {
    return this.readyAt?.getTime() ?? null;
  }

  /**
   * How long it has been since the client last entered the `READY` state in milliseconds
   * @type {?number}
   * @readonly
   */
  get uptime() {
    return this.readyAt ? Date.now() - this.readyAt : null;
  }

  /**
   * Logs the client in, establishing a WebSocket connection to Discord.
   * @param {string} [token=this.token] Token of the account to log in with
   * @returns {Promise<string>} Token of the account used
   * @example
   * client.login('my token');
   */
  async login(token = this.token) {
    this.token = token = stringPredicate.parse(token).replace(/^(Bot|Bearer)\s*/i, '');
    this.emit(
      Events.DEBUG,
      `Provided token: ${token
        .split('.')
        .map((val, i) => (i > 1 ? val.replace(/./g, '*') : val))
        .join('.')}`,
    );

    if (this.options.presence) {
      this.options.ws.presence = this.presence._parse(this.options.presence);
    }

    this.emit(Events.DEBUG, 'Preparing to connect to the gateway...');

    try {
      await this.ws.connect();
      return this.token;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  /**
   * Returns whether the client has logged in, indicative of being able to access
   * properties such as `user` and `application`.
   * @returns {boolean}
   */
  isReady() {
    return this.ws.status === Status.READY;
  }

  /**
   * Logs out, terminates the connection to Discord, and destroys the client.
   * @returns {void}
   */
  destroy() {
    super.destroy();

    for (const fn of this._cleanups) fn();
    this._cleanups.clear();

    if (this.sweepMessageInterval) clearInterval(this.sweepMessageInterval);

    this.ws.destroy();
    this.token = null;
  }

  /**
   * Obtains an invite from Discord.
   * @param {InviteResolvable} invite Invite code or URL
   * @returns {Promise<Invite>}
   * @example
   * client.fetchInvite('https://discord.gg/djs')
   *   .then(invite => console.log(`Obtained invite with code: ${invite.code}`))
   *   .catch(console.error);
   */
  async fetchInvite(invite) {
    const code = DataResolver.resolveInviteCode(invite);
    const data = await this.api.invites(code).get({ query: { with_counts: true, with_expiration: true } });
    return new Invite(this, data);
  }

  /**
   * Obtains a template from Discord.
   * @param {GuildTemplateResolvable} template Template code or URL
   * @returns {Promise<GuildTemplate>}
   * @example
   * client.fetchGuildTemplate('https://discord.new/FKvmczH2HyUf')
   *   .then(template => console.log(`Obtained template with code: ${template.code}`))
   *   .catch(console.error);
   */
  async fetchGuildTemplate(template) {
    const code = DataResolver.resolveGuildTemplateCode(template);
    const data = await this.api.guilds.templates(code).get();
    return new GuildTemplate(this, data);
  }

  /**
   * Obtains a webhook from Discord.
   * @param {Snowflake} id The webhook's id
   * @param {string} [token] Token for the webhook
   * @returns {Promise<Webhook>}
   * @example
   * client.fetchWebhook('id', 'token')
   *   .then(webhook => console.log(`Obtained webhook with name: ${webhook.name}`))
   *   .catch(console.error);
   */
  async fetchWebhook(id, token) {
    const data = await this.api.webhooks(id, token).get();
    return new Webhook(this, { token, ...data });
  }

  /**
   * Obtains the available voice regions from Discord.
   * @returns {Promise<Collection<string, VoiceRegion>>}
   * @example
   * client.fetchVoiceRegions()
   *   .then(regions => console.log(`Available regions are: ${regions.map(region => region.name).join(', ')}`))
   *   .catch(console.error);
   */
  async fetchVoiceRegions() {
    const apiRegions = await this.api.voice.regions.get();
    const regions = new Collection();
    for (const region of apiRegions) regions.set(region.id, new VoiceRegion(region));
    return regions;
  }

  /**
   * Obtains a sticker from Discord.
   * @param {Snowflake} id The sticker's id
   * @returns {Promise<Sticker>}
   * @example
   * client.fetchSticker('id')
   *   .then(sticker => console.log(`Obtained sticker with name: ${sticker.name}`))
   *   .catch(console.error);
   */
  async fetchSticker(id) {
    const data = await this.api.stickers(id).get();
    return new Sticker(this, data);
  }

  /**
   * Obtains the list of sticker packs available to Nitro subscribers from Discord.
   * @returns {Promise<Collection<Snowflake, StickerPack>>}
   * @example
   * client.fetchPremiumStickerPacks()
   *   .then(packs => console.log(`Available sticker packs are: ${packs.map(pack => pack.name).join(', ')}`))
   *   .catch(console.error);
   */
  async fetchPremiumStickerPacks() {
    const data = await this.api('sticker-packs').get();
    return new Collection(data.sticker_packs.map(p => [p.id, new StickerPack(this, p)]));
  }
  /**
   * A last ditch cleanup function for garbage collection.
   * @param {Function} options.cleanup The function called to GC
   * @param {string} [options.message] The message to send after a successful GC
   * @param {string} [options.name] The name of the item being GCed
   * @private
   */
  _finalize({ cleanup, message, name }) {
    try {
      cleanup();
      this._cleanups.delete(cleanup);
      if (message) {
        this.emit(Events.DEBUG, message);
      }
    } catch {
      this.emit(Events.DEBUG, `Garbage collection failed on ${name ?? 'an unknown item'}.`);
    }
  }

  /**
   * Sweeps all text-based channels' messages and removes the ones older than the max message lifetime.
   * If the message has been edited, the time of the edit is used rather than the time of the original message.
   * @param {number} [lifetime=this.options.messageCacheLifetime] Messages that are older than this (in seconds)
   * will be removed from the caches. The default is based on {@link ClientOptions#messageCacheLifetime}
   * @returns {number} Amount of messages that were removed from the caches,
   * or -1 if the message cache lifetime is unlimited
   * @example
   * // Remove all messages older than 1800 seconds from the messages cache
   * const amount = client.sweepMessages(1800);
   * console.log(`Successfully removed ${amount} messages from the cache.`);
   */
  sweepMessages(lifetime = this.options.messageCacheLifetime) {
    if (typeof lifetime !== 'number' || isNaN(lifetime)) {
      throw new TypeError('INVALID_TYPE', 'lifetime', 'number');
    }
    if (lifetime <= 0) {
      this.emit(Events.DEBUG, "Didn't sweep messages - lifetime is unlimited");
      return -1;
    }

    const lifetimeMs = lifetime * 1_000;
    const now = Date.now();
    let channels = 0;
    let messages = 0;

    for (const channel of this.channels.cache.values()) {
      if (!channel.messages) continue;
      channels++;

      messages += channel.messages.cache.sweep(
        message => now - (message.editedTimestamp ?? message.createdTimestamp) > lifetimeMs,
      );
    }

    this.emit(
      Events.DEBUG,
      `Swept ${messages} messages older than ${lifetime} seconds in ${channels} text-based channels`,
    );
    return messages;
  }

  /**
   * Obtains a guild preview from Discord, available for all guilds the bot is in and all Discoverable guilds.
   * @param {GuildResolvable} guild The guild to fetch the preview for
   * @returns {Promise<GuildPreview>}
   */
  async fetchGuildPreview(guild) {
    const id = this.guilds.resolveId(guild);
    if (!id) throw new TypeError('INVALID_TYPE', 'guild', 'GuildResolvable');
    const data = await this.api.guilds(id).preview.get();
    return new GuildPreview(this, data);
  }

  /**
   * Obtains the widget data of a guild from Discord, available for guilds with the widget enabled.
   * @param {GuildResolvable} guild The guild to fetch the widget data for
   * @returns {Promise<Widget>}
   */
  async fetchGuildWidget(guild) {
    const id = this.guilds.resolveId(guild);
    if (!id) throw new TypeError('INVALID_TYPE', 'guild', 'GuildResolvable');
    const data = await this.api.guilds(id, 'widget.json').get();
    return new Widget(this, data);
  }

  /**
   * Options for {@link Client#generateInvite}.
   * @typedef {Object} InviteGenerationOptions
   * @property {InviteScope[]} scopes Scopes that should be requested
   * @property {PermissionResolvable} [permissions] Permissions to request
   * @property {GuildResolvable} [guild] Guild to preselect
   * @property {boolean} [disableGuildSelect] Whether to disable the guild selection
   */

  /**
   * Generates a link that can be used to invite the bot to a guild.
   * @param {InviteGenerationOptions} [options={}] Options for the invite
   * @returns {string}
   * @example
   * const link = client.generateInvite({
   *   scopes: ['applications.commands'],
   * });
   * console.log(`Generated application invite link: ${link}`);
   * @example
   * const link = client.generateInvite({
   *   permissions: [
   *     Permissions.FLAGS.SEND_MESSAGES,
   *     Permissions.FLAGS.MANAGE_GUILD,
   *     Permissions.FLAGS.MENTION_EVERYONE,
   *   ],
   *   scopes: ['bot'],
   * });
   * console.log(`Generated bot invite link: ${link}`);
   */
  generateInvite(options) {
    if (!this.application) throw new Error('CLIENT_NOT_READY', 'generate an invite link');
    const resolved = invitePredicate.parse(options);

    const query = new URLSearchParams({
      client_id: this.application.id,
    });

    query.set('scope', resolved.scopes.join(' '));

    if (resolved.permissions) {
      query.set('permissions', resolved.permissions.toString());
    }

    if (resolved.disableGuildSelect) {
      query.set('disable_guild_select', 'true');
    }

    if (resolved.guild) {
      const guildId = this.guilds.resolveId(resolved.guild);
      if (!guildId) throw new TypeError('INVALID_TYPE', 'options.guild', 'GuildResolvable');
      query.set('guild_id', guildId);
    }

    return `${this.options.http.api}${this.api.oauth2.authorize}?${query}`;
  }

  toJSON() {
    return super.toJSON({
      readyAt: false,
    });
  }

  /**
   * Calls {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval} on a script
   * with the client as `this`.
   * @param {string} script Script to eval
   * @returns {*}
   * @private
   */
  _eval(script) {
    return eval(script);
  }
}

module.exports = Client;

/**
 * Emitted for general warnings.
 * @event Client#warn
 * @param {string} info The warning
 */

/**
 * @external Collection
 * @see {@link https://discord.js.org/#/docs/collection/main/class/Collection}
 */
