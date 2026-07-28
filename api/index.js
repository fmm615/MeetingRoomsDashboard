"use strict";

const {
  createRequestHandler
} = require("../server");
const {
  createSupabaseStoreFromEnv
} = require("../lib/supabase-store");

let handler;

module.exports = async function vercelHandler(request, response) {
  if (!handler) {
    handler = createRequestHandler({
      store: createSupabaseStoreFromEnv(),
      apiOnly: true
    });
  }
  return handler(request, response);
};
