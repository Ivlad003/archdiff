/** A store named like an SCAPI client, which is none: `shopperStore.getState()` is no operation. */
export const shopperStore = {
  getState(): { selected: number } {
    return { selected: 1 };
  },
};
