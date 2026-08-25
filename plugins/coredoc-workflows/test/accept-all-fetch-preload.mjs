globalThis.fetch = async (_target, init) => {
  const batch = JSON.parse(init.body);
  return {
    ok: true,
    json: async () => ({
      acceptedEventIds: batch.events.map((event) => event.eventId),
      duplicateEventIds: [],
      rejected: [],
    }),
  };
};
