import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, LoaderCircleIcon } from "lucide-react";
import { DEFAULT_MODEL } from "@homepage/agent-core";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PRESET_OPTIONS, catalogAllowed, loadModelOptions, type CatalogResult, type ModelOption } from "@/lib/model-catalog";
import { cn } from "@/lib/utils";

/**
 * Free-text model id with a picker beside it. The picker lists the curated
 * presets and, when the endpoint is OpenRouter, every tool-calling model from
 * OpenRouter's public catalog (an anonymous GET made the first time it opens).
 */
export function ModelCombobox({
  value,
  onChange,
  onCommit,
  baseUrl,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Persist; called on blur and when a model is picked. */
  onCommit: (next?: string) => void;
  /** The current base URL draft; the catalog is only loaded for OpenRouter. */
  baseUrl: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const requested = useRef<string | null>(null);
  const allowed = catalogAllowed(baseUrl);

  useEffect(() => {
    if (!open || !allowed || requested.current === "openrouter") return;
    requested.current = "openrouter";
    const ctrl = new AbortController();
    setLoading(true);
    void loadModelOptions({ baseUrl, signal: ctrl.signal }).then((r) => {
      setCatalog(r);
      setLoading(false);
      // Let a later open retry after a failure.
      if (r.source !== "catalog") requested.current = null;
    });
    return () => ctrl.abort();
  }, [open, allowed, baseUrl]);

  const options: ModelOption[] = allowed && catalog ? catalog.options : PRESET_OPTIONS;
  const presets = options.filter((o) => o.preset);
  const others = options.filter((o) => !o.preset);
  const current = value.trim() || DEFAULT_MODEL;

  const pick = (next: string) => {
    onChange(next);
    onCommit(next);
    setOpen(false);
  };

  const item = (o: ModelOption) => (
    <CommandItem key={o.id} value={o.id} keywords={[o.label]} onSelect={() => pick(o.id)}>
      <CheckIcon className={cn("size-4", current === o.id ? "opacity-100" : "opacity-0")} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-xs">{o.id}</span>
        <span className="truncate text-xs text-muted-foreground">
          {o.label}
          {o.id === DEFAULT_MODEL ? " · default" : ""}
          {o.contextLength ? ` · ${Math.round(o.contextLength / 1000)}k ctx` : ""}
        </span>
      </div>
      {o.free && (
        <span className="rounded-sm bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">free</span>
      )}
    </CommandItem>
  );

  return (
    <div className="flex gap-2">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit()}
        placeholder={DEFAULT_MODEL}
        spellCheck={false}
        autoComplete="off"
        className="font-mono"
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" role="combobox" aria-expanded={open} aria-label="Choose a model" className="shrink-0">
            Presets
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[420px] p-0" align="end">
          <Command>
            <CommandInput placeholder="Search models…" />
            <CommandList>
              <CommandEmpty>No model matches. You can still type any id in the field.</CommandEmpty>
              <CommandGroup heading="Presets">{presets.map(item)}</CommandGroup>
              {others.length > 0 && (
                <CommandGroup heading={`OpenRouter · tool calling (${others.length})`}>{others.map(item)}</CommandGroup>
              )}
            </CommandList>
            <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
              {loading ? (
                <>
                  <LoaderCircleIcon className="size-3 animate-spin" /> Loading OpenRouter's public model list…
                </>
              ) : !allowed ? (
                "Custom endpoint: showing presets only."
              ) : catalog?.source === "fetch-failed" ? (
                `Couldn't load OpenRouter's list (${catalog.error}); showing presets.`
              ) : catalog?.source === "catalog" ? (
                "From OpenRouter's public list, filtered to models that support tools."
              ) : (
                "Presets"
              )}
            </div>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
