using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using BrawlLib.SSBB.ResourceNodes;

namespace MovesetRoundTrip
{
    // Diagnostic harness for the PSA/moveset rebuilder.
    //
    // Enables ParseMoveDef, loads a fighter pac (or a raw extracted moveset),
    // and measures how byte-stable the moveset rebuild is. Two signals per MoveDef:
    //
    //   1. original vs rebuilt (B0 vs B1): how much the rebuilder canonicalizes
    //      layout. A non-zero diff here is EXPECTED -- BrawlCrate lays moveset data
    //      out in its own order, which need not match Nintendo's.
    //   2. idempotency (B1 vs B2): rebuild once -> bytes B1; reparse B1 standalone
    //      and rebuild again -> B2. A correct, deterministic rebuilder must produce
    //      B1 == B2. If it doesn't, the rebuild is buggy and that's the thing to fix
    //      before event/script editing can be trusted.
    //
    // Exit: 0 = every MoveDef is idempotent, 1 = at least one is not / a failure,
    //       2 = bad usage.
    internal static unsafe class Program
    {
        private static int Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.WriteLine("Usage: MovesetRoundTrip <FitXxx.pac | raw moveset> [outDir]");
                Console.WriteLine();
                Console.WriteLine("Enables ParseMoveDef, rebuilds the moveset section(s), reports byte diffs.");
                Console.WriteLine("Exit 0 = rebuild idempotent, 1 = not idempotent/failure, 2 = bad usage.");
                return 2;
            }

            string path = Path.GetFullPath(args[0]);
            if (!File.Exists(path))
            {
                Console.WriteLine($"File not found: {path}");
                return 2;
            }

            string outDir = args.Length > 1 ? Path.GetFullPath(args[1]) : Path.GetDirectoryName(path);
            Directory.CreateDirectory(outDir);

            BrawlLib.Properties.Settings.Default.ParseMoveDef = true;

            // Diagnostic: optionally do a throwaway parse first to "warm" static state,
            // so we can tell whether a 2nd FRESH load in one session under-parses too.
            if (Environment.GetEnvironmentVariable("MOVESET_WARMUP") == "1")
            {
                ResourceNode w = NodeFactory.FromFile(null, path);
                Walk(w, _ => { });
                TryDispose(w);
                Console.WriteLine("[warmup parse done]");
            }

            Console.WriteLine($"== Loading {path} ==");
            ResourceNode root = NodeFactory.FromFile(null, path);
            if (root == null)
            {
                Console.WriteLine("NodeFactory returned null (unrecognized file).");
                return 1;
            }

            var moveDefs = new List<MoveDefNode>();
            Walk(root, n =>
            {
                if (n is MoveDefNode md)
                {
                    moveDefs.Add(md);
                }
            });

            Console.WriteLine($"Root: {root.GetType().Name} \"{root.Name}\"  |  MoveDefNodes found: {moveDefs.Count}");

            if (moveDefs.Count == 0)
            {
                Console.WriteLine();
                Console.WriteLine("No MoveDef section parsed. Top-level children:");
                foreach (ResourceNode c in Snapshot(root))
                {
                    Console.WriteLine($"    {c.Name}  [{c.GetType().Name}]");
                }

                TryDispose(root);
                return 1;
            }

            int idx = 0;
            bool allIdempotent = true;
            foreach (MoveDefNode md in moveDefs)
            {
                string label = md.Parent != null ? $"{md.Parent.Name}/{md.Name}" : md.Name;
                Console.WriteLine();
                Console.WriteLine($"== MoveDef [{idx}]: {label} ==");
                Summarize("  loaded", md);

                try
                {
                    if (!RoundTripOne(md, path, outDir, idx))
                    {
                        allIdempotent = false;
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[FAIL] entry threw: {ex.GetType().Name}: {ex.Message}");
                    allIdempotent = false;
                }

                idx++;
            }

            TryDispose(root);

            // Produce a freshly-rebuilt .pac (clean load, no harness mutations) so we
            // can re-open it in a SEPARATE process and see whether the rebuild's output
            // recovers all subroutines on a true cold parse.
            if (string.Equals(Path.GetExtension(path), ".pac", StringComparison.OrdinalIgnoreCase))
            {
                string rebuiltPac = Path.Combine(outDir,
                    Path.GetFileNameWithoutExtension(path) + ".rebuilt" + Path.GetExtension(path));
                try
                {
                    ResourceNode r = NodeFactory.FromFile(null, path);
                    Walk(r, _ => { }); // full populate -> discovers transitive subroutines
                    r.Rebuild(true);

                    // Clean rebuilt moveset blob (no Replace pollution), for byte-idempotency.
                    MoveDefNode cleanMd = null;
                    Walk(r, n =>
                    {
                        if (cleanMd == null && n is MoveDefNode m)
                        {
                            cleanMd = m;
                        }
                    });
                    if (cleanMd != null)
                    {
                        byte[] clean = CopyBytes(cleanMd.WorkingUncompressed);
                        string cleanPath = Path.Combine(outDir,
                            Path.GetFileNameWithoutExtension(path) + ".clean.b1.bin");
                        File.WriteAllBytes(cleanPath, clean);
                        Console.WriteLine($"Clean rebuilt moveset: {clean.Length} bytes -> {cleanPath}");
                    }

                    r.Export(rebuiltPac);
                    TryDispose(r);
                    Console.WriteLine($"Wrote rebuilt pac: {rebuiltPac}");
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"\nrebuilt-pac export failed: {ex.GetType().Name}: {ex.Message}");
                }
            }

            Console.WriteLine();
            Console.WriteLine(allIdempotent
                ? "RESULT: all MoveDef rebuilds are idempotent (B1 == B2). Rebuilder is stable for this file."
                : "RESULT: at least one MoveDef rebuild is NOT idempotent / failed. See diffs above.");
            return allIdempotent ? 0 : 1;
        }

        // One MoveDef round-trip, in ARC context. Returns true if idempotent.
        //   B0 = bytes as loaded.
        //   B1 = bytes after one forced rebuild.
        //   B2 = bytes after replacing the entry with B1 (re-parse in place) and
        //        rebuilding again. Correct deterministic rebuild => B1 == B2.
        private static bool RoundTripOne(MoveDefNode md, string srcPath, string outDir, int idx)
        {
            string stem = Path.GetFileNameWithoutExtension(srcPath);

            byte[] b0 = CopyBytes(md.WorkingUncompressed);
            RefScan(md);
            Dictionary<string, string> d0 = Dump(md);

            // SAFE-PATH validation: "save" by writing the original bytes back
            // (optionally with a size-preserving in-place value patch) WITHOUT
            // invoking MovesetConverter. Reparse and confirm nothing is lost.
            // This is the model the scoped editor would use.
            byte[] raw = (byte[]) b0.Clone();
            // Simulate a real attribute edit: flip the 4 bytes of attribute[0]
            // (first float after the 0x20 header + 4-byte data header pointer).
            int patchOff = PatchOffset(md);
            if (patchOff >= 0 && patchOff + 4 <= raw.Length)
            {
                raw[patchOff] ^= 0x01; // tiny size-preserving change
            }

            string rawPath = Path.Combine(outDir, $"{stem}.md{idx}.raw.bin");
            File.WriteAllBytes(rawPath, raw);
            md.Replace(rawPath);
            Dictionary<string, string> dRaw = Dump(md);
            DiffDumps("  RAW no-rebuild save ", d0, dRaw);
            Compare("  B0 vs RAW patched save", b0, raw);

            // restore md to the true original before exercising the rebuild path
            File.WriteAllBytes(rawPath, b0);
            md.Replace(rawPath);
            d0 = Dump(md);

            md.Rebuild(true);
            byte[] b1 = CopyBytes(md.WorkingUncompressed);
            Console.WriteLine($"  size: {b0.Length} -> {b1.Length} bytes (delta {b1.Length - b0.Length})");
            Compare("  B0 loaded    vs B1 rebuilt   ", b0, b1);

            // Re-parse B1 in place (keeps the ARC parent, so OnInitialize is happy).
            string b1Path = Path.Combine(outDir, $"{stem}.md{idx}.b1.bin");
            File.WriteAllBytes(b1Path, b1);
            md.Replace(b1Path);
            Dictionary<string, string> d1 = Dump(md); // forces populate from B1

            md.Rebuild(true);
            byte[] b2 = CopyBytes(md.WorkingUncompressed);
            bool idem = Compare("  B1 rebuilt   vs B2 re-rebuilt", b1, b2);

            // The key diagnostic: what did the FIRST rebuild drop/change?
            Console.WriteLine();
            DiffDumps("  D0->D1 first rebuild", d0, d1);
            WriteDump(Path.Combine(outDir, $"{stem}.md{idx}.d0.txt"), d0);
            WriteDump(Path.Combine(outDir, $"{stem}.md{idx}.d1.txt"), d1);

            // Best-effort: structural view of the non-idempotency (B2 can be degraded).
            string b2Path = Path.Combine(outDir, $"{stem}.md{idx}.b2.bin");
            File.WriteAllBytes(b2Path, b2);
            try
            {
                md.Replace(b2Path);
                Dictionary<string, string> d2 = Dump(md);
                DiffDumps("  D1->D2 idempotency  ", d1, d2);
                WriteDump(Path.Combine(outDir, $"{stem}.md{idx}.d2.txt"), d2);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"  [warn] reparsing B2 failed ({ex.GetType().Name}) -- 2nd rebuild output is unparseable.");
            }

            return idem;
        }

        // Byte offset (within the MoveDef's uncompressed buffer) of the first
        // attribute value -- a realistic, size-preserving edit target. _offset is
        // relative to BaseAddress (= header + 0x20), so add 0x20.
        private static int PatchOffset(MoveDefNode md)
        {
            int result = -1;
            Walk(md, n =>
            {
                if (result < 0 && n is MoveDefAttributeNode attr)
                {
                    result = attr._offset + 0x20;
                }
            });
            return result;
        }

        // Scan every event offset-parameter and report which subroutine indices are
        // referenced. If 28..33 ARE referenced but still get pruned, the rebuild's
        // reference tracking is the bug.
        private static void RefScan(MoveDefNode md)
        {
            var subRefs = new Dictionary<int, int>();
            var subReferrers = new Dictionary<int, List<string>>();
            int total = 0;
            Walk(md, n =>
            {
                if (n is MoveDefEventOffsetNode off && off.list == 2)
                {
                    subRefs.TryGetValue(off.index, out int c);
                    subRefs[off.index] = c + 1;
                    total++;

                    // Find the action that contains this reference.
                    ResourceNode a = off;
                    while (a != null && !(a is MoveDefActionNode))
                    {
                        a = a.Parent;
                    }

                    if (!subReferrers.TryGetValue(off.index, out List<string> list))
                    {
                        subReferrers[off.index] = list = new List<string>();
                    }

                    list.Add(a != null ? PathOf(a, md) : "?");
                }
            });

            int subCount = 0;
            try
            {
                subCount = md._subRoutineList?.Count ?? 0;
            }
            catch
            {
                // ignore
            }

            var unref = new List<int>();
            for (int i = 0; i < subCount; i++)
            {
                if (!subRefs.ContainsKey(i))
                {
                    unref.Add(i);
                }
            }

            Console.WriteLine($"  subroutine refs: {total} offset-params -> {subRefs.Count}/{subCount} distinct indices referenced");
            Console.WriteLine($"  UNREFERENCED subroutine indices ({unref.Count}): [{string.Join(",", unref)}]");
            // How many subroutines have an EMPTY _actionRefs (the list the rebuild
            // gate actually checks) despite being referenced by an offset param?
            int emptyActionRefs = 0;
            try
            {
                for (int i = 0; i < subCount; i++)
                {
                    if (md._subRoutineList[i] is MoveDefActionNode a && a._actionRefs.Count == 0)
                    {
                        emptyActionRefs++;
                    }
                }
            }
            catch
            {
                emptyActionRefs = -1;
            }

            Console.WriteLine($"  subroutines with EMPTY _actionRefs (rebuild gate): {emptyActionRefs}");

            int from = Math.Max(0, subCount - 8);
            for (int i = from; i < subCount; i++)
            {
                subRefs.TryGetValue(i, out int c);
                subReferrers.TryGetValue(i, out List<string> who);
                string referrers = who != null ? string.Join("; ", who) : "";
                int aref = -1;
                try
                {
                    aref = (md._subRoutineList[i] as MoveDefActionNode)._actionRefs.Count;
                }
                catch
                {
                    // ignore
                }

                Console.WriteLine($"    SubRoutine{i}: offsetRefs={c} _actionRefs={aref}  <- {referrers}");
            }
        }

        // Canonical per-action event dump. Key = action path within the MoveDef,
        // value = the action's event sequence (id + parameter encodings).
        private static Dictionary<string, string> Dump(MoveDefNode md)
        {
            var actions = new List<MoveDefActionNode>();
            Walk(md, n =>
            {
                if (n is MoveDefActionNode a)
                {
                    actions.Add(a);
                }
            });

            var dict = new Dictionary<string, string>();
            foreach (MoveDefActionNode a in actions)
            {
                string path = PathOf(a, md);
                string key = path;
                int k = 1;
                while (dict.ContainsKey(key))
                {
                    key = path + "#" + (++k);
                }

                var sb = new System.Text.StringBuilder();
                foreach (ResourceNode c in Snapshot(a))
                {
                    if (!(c is MoveDefEventNode e))
                    {
                        continue;
                    }

                    sb.Append(((uint) e._event).ToString("X8")).Append('(');
                    foreach (ResourceNode pc in Snapshot(e))
                    {
                        if (pc is MoveDefEventOffsetNode off)
                        {
                            sb.Append($"O[{off.list},{off.type},{off.index}]");
                        }
                        else if (pc is MoveDefEventParameterNode p)
                        {
                            sb.Append($"{(int) p._type}:{p._value}");
                        }

                        sb.Append(',');
                    }

                    sb.Append(") ");
                }

                dict[key] = sb.ToString();
            }

            return dict;
        }

        private static string PathOf(ResourceNode n, ResourceNode stop)
        {
            var parts = new List<string>();
            ResourceNode cur = n;
            while (cur != null && cur != stop)
            {
                parts.Add(cur.Name ?? "?");
                cur = cur.Parent;
            }

            parts.Reverse();
            return string.Join("/", parts);
        }

        private static int EventCount(string sig)
        {
            int n = 0;
            foreach (char c in sig)
            {
                if (c == '(')
                {
                    n++;
                }
            }

            return n;
        }

        private static void DiffDumps(string label, Dictionary<string, string> a, Dictionary<string, string> b)
        {
            int removed = 0, added = 0, changed = 0, evtA = 0, evtB = 0;
            var examples = new List<string>();

            foreach (var kv in a)
            {
                evtA += EventCount(kv.Value);
                if (!b.TryGetValue(kv.Key, out string bv))
                {
                    removed++;
                    if (examples.Count < 25)
                    {
                        examples.Add($"    - REMOVED {kv.Key}  ({EventCount(kv.Value)} events)");
                    }
                }
                else if (kv.Value != bv)
                {
                    changed++;
                    if (examples.Count < 25)
                    {
                        examples.Add($"    ~ CHANGED {kv.Key}  (events {EventCount(kv.Value)} -> {EventCount(bv)})");
                    }
                }
            }

            foreach (var kv in b)
            {
                evtB += EventCount(kv.Value);
                if (!a.ContainsKey(kv.Key))
                {
                    added++;
                    if (examples.Count < 25)
                    {
                        examples.Add($"    + ADDED   {kv.Key}  ({EventCount(kv.Value)} events)");
                    }
                }
            }

            Console.WriteLine(
                $"{label}: actions {a.Count}->{b.Count}, events {evtA}->{evtB} | removed={removed} added={added} changed={changed}");
            foreach (string e in examples)
            {
                Console.WriteLine(e);
            }
        }

        private static void WriteDump(string path, Dictionary<string, string> d)
        {
            var lines = new List<string>();
            foreach (var kv in d.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                lines.Add($"{kv.Key}\t{EventCount(kv.Value)}\t{kv.Value}");
            }

            File.WriteAllLines(path, lines);
        }

        // Snapshot a node's children (forces lazy populate) tolerant of the tree
        // mutating itself during populate -- the moveset parser restructures siblings.
        private static ResourceNode[] Snapshot(ResourceNode n)
        {
            try
            {
                return n.Children.ToArray();
            }
            catch (InvalidOperationException)
            {
                // Children mutated mid-enumeration; retry once on the settled list.
                try
                {
                    return n.Children.ToArray();
                }
                catch
                {
                    return Array.Empty<ResourceNode>();
                }
            }
        }

        private static void Walk(ResourceNode n, Action<ResourceNode> visit)
        {
            visit(n);
            foreach (ResourceNode c in Snapshot(n))
            {
                Walk(c, visit);
            }
        }

        private static void Summarize(string prefix, MoveDefNode md)
        {
            int events = 0, actions = 0, subs = 0;
            Walk(md, n =>
            {
                switch (n)
                {
                    case MoveDefEventNode _:
                        events++;
                        break;
                    case MoveDefActionNode _:
                        actions++;
                        break;
                }
            });
            // subroutine list count, if exposed
            try
            {
                subs = md._subRoutineList?.Count ?? 0;
            }
            catch
            {
                subs = -1;
            }

            Console.WriteLine($"{prefix}: events={events} actions={actions} subroutines={subs}");
        }

        private static byte[] CopyBytes(DataSource src)
        {
            byte[] b = new byte[src.Length];
            if (src.Length > 0)
            {
                Marshal.Copy((IntPtr) src.Address, b, 0, src.Length);
            }

            return b;
        }

        // Returns true when a and b are byte-identical.
        private static bool Compare(string label, byte[] a, byte[] b)
        {
            int min = Math.Min(a.Length, b.Length);
            int first = -1;
            int diffs = 0;
            for (int i = 0; i < min; i++)
            {
                if (a[i] != b[i])
                {
                    if (first < 0)
                    {
                        first = i;
                    }

                    diffs++;
                }
            }

            diffs += Math.Abs(a.Length - b.Length);

            if (a.Length == b.Length && diffs == 0)
            {
                Console.WriteLine($"[OK]   {label}: identical ({a.Length} bytes)");
                return true;
            }

            string where = first < 0 ? $"@0x{min:X} (length only)" : $"@0x{first:X}";
            Console.WriteLine($"[DIFF] {label}: len {a.Length} -> {b.Length}, first diff {where}, {diffs} differing byte(s)");
            return false;
        }

        private static void TryDispose(ResourceNode n)
        {
            try
            {
                n?.Dispose();
            }
            catch
            {
                // ignore
            }
        }
    }
}
