/**
 * Which hosts may deliver to the receiver: explicit CIDR ranges, or
 * `google`, the ranges Google publishes for its sending servers (the SPF
 * record of `_spf.google.com` and the netblocks it includes). All mail for
 * this deployment comes through Google; port 25 answers nobody else.
 */

import { promises as dnsPromises } from "node:dns";
import { BlockList, isIP } from "node:net";

type TxtResolver = (name: string) => Promise<string[][]>;

const GOOGLE_SPF = "_spf.google.com";
const MAX_INCLUDES = 10;

/** The ip4:/ip6: ranges of an SPF record, following include: (bounded). */
export async function spfRanges(
    name: string,
    resolveTxt: TxtResolver = (host) => dnsPromises.resolveTxt(host),
): Promise<string[]> {
    const ranges: string[] = [];
    const seen = new Set<string>();
    const queue = [name];
    while (queue.length > 0 && seen.size < MAX_INCLUDES) {
        const host = queue.shift() ?? "";
        if (seen.has(host)) continue;
        seen.add(host);
        const records = (await resolveTxt(host)).map((parts) => parts.join(""));
        const spf = records.find((record) => record.startsWith("v=spf1"));
        if (!spf) continue;
        for (const term of spf.split(/\s+/)) {
            const colon = term.indexOf(":");
            if (colon <= 0) continue;
            const mechanism = term.slice(0, colon);
            const value = term.slice(colon + 1);
            if (!value) continue;
            if (mechanism === "ip4" || mechanism === "ip6") ranges.push(value);
            else if (mechanism === "include") queue.push(value);
        }
    }
    return ranges;
}

function addRange(list: BlockList, range: string): boolean {
    const [address, prefixText] = range.split("/");
    const family = isIP(address ?? "");
    if (!address || family === 0) return false;
    const type = family === 6 ? "ipv6" : "ipv4";
    if (prefixText === undefined) {
        list.addAddress(address, type);
        return true;
    }
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix)) return false;
    list.addSubnet(address, prefix, type);
    return true;
}

/** A source allowlist, to be refreshed for `google`. */
export class AllowedSources {
    private list: BlockList | null = null;
    private anyone = false;

    constructor(
        private readonly spec: string,
        private readonly resolveTxt?: TxtResolver,
    ) {}

    /** Loads the ranges; keeps the previous ones when a refresh fails. */
    async refresh(): Promise<void> {
        const entries = this.spec
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
        if (entries.includes("*")) {
            this.anyone = true;
            return;
        }
        const ranges: string[] = [];
        for (const entry of entries) {
            if (entry === "google") {
                ranges.push(...(await spfRanges(GOOGLE_SPF, this.resolveTxt)));
            } else {
                ranges.push(entry);
            }
        }
        const list = new BlockList();
        let added = 0;
        for (const range of ranges) if (addRange(list, range)) added++;
        if (added === 0) throw new Error("No allowed source ranges");
        this.list = list;
    }

    /** Whether `address` may deliver; nobody before the first refresh. */
    allows(address: string): boolean {
        if (this.anyone) return true;
        if (!this.list) return false;
        const mapped = address.replace(/^::ffff:/i, "");
        const family = isIP(mapped);
        if (family === 0) return false;
        return this.list.check(mapped, family === 6 ? "ipv6" : "ipv4");
    }
}
