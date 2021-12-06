'use strict';

const { z } = require('zod');
const { Colors } = require('./Constants');

exports.stringPredicate = z.string().nonempty();
exports.bytePredicate = z.number().int().gte(0).lte(0xff);
exports.colorResolvablePredicate = z
  .literal('RANDOM')
  .transform(() => Math.floor(Math.random() * (0xffffff + 1)))
  .or(z.literal('DEFAULT').transform(() => 0))
  .or(exports.stringPredicate.transform(color => Colors[color] ?? parseInt(color.replace('#', ''), 16)))
  .or(
    z
      .tuple([exports.bytePredicate, exports.bytePredicate, exports.bytePredicate])
      .transform(color => (color[0] << 16) + (color[1] << 8) + color[2]),
  )
  .or(z.number().int().gte(0).lte(0xffffff));
exports.collectorOptionsPredicate = z.strictObject({
  filter: z.function().default(() => () => true),
  time: z.number().int().gte(0).optional(),
  idle: z.number().int().gte(0).optional(),
});
