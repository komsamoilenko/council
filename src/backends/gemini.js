// Owns provider dispatch while retaining the four backend identifiers; specification §6.1.
'use strict';
const api=require('./gemini-api'),agy=require('./gemini-agy');
const provider=ctx=>(ctx.config.gemini || {}).provider==='agy'?agy:api;
module.exports={id:'gemini',vendor:'google',expectedImage:api.expectedImage,expectedImageFor:ctx=>provider(ctx).expectedImage,effortLevels:['low','medium','high'],defaultTimeoutS:900,maxTimeoutS:1800,binaryPath:c=>provider(c).binaryPath(c),versionSpec:c=>provider(c).versionSpec(c),available:(c,o)=>provider(c).available(c,o),buildSpawn:(c,o)=>provider(c).buildSpawn(c,o),parse:(c,o)=>provider(c).parse(c,o)};
