import type { RowStoreView } from "../../src/services/identity.js";

/** In-memory row-store view: UID -> latest captured caption. */
export class FakeRowStoreView implements RowStoreView {
  private readonly captions = new Map<string, string>();

  set(uid: string, caption: string): void {
    this.captions.set(uid.toUpperCase(), caption);
  }

  captionOf(uid: string): string | undefined {
    return this.captions.get(uid.toUpperCase());
  }
}
