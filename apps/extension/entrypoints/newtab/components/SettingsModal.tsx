import { useState } from "react";
import { toast } from "sonner";
import { DEFAULT_BASE_URL, normalizeBaseUrl, normalizeBlockList, normalizeModelId, type HomepageModel } from "@homepage/agent-core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ModelCombobox } from "./ModelCombobox";

const help = "text-xs text-muted-foreground leading-relaxed";

export function SettingsModal({
  initialPrompt,
  blockedSites,
  model,
  onChangeModel,
  baseUrl,
  onChangeBaseUrl,
  onChangeApiKey,
  autoRebuild,
  onToggleAutoRebuild,
  onClose,
  onSave,
}: {
  initialPrompt: string;
  blockedSites: string[];
  model: HomepageModel;
  onChangeModel: (next: HomepageModel) => void | Promise<void>;
  baseUrl: string;
  onChangeBaseUrl: (next: string) => void | Promise<void>;
  onChangeApiKey: (next: string) => void | Promise<void>;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  onClose: () => void;
  onSave: (prompt: string, blockedSites: string[]) => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  const [modelDraft, setModelDraft] = useState(model);
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [tab, setTab] = useState("content");

  const commitModel = async (raw: string = modelDraft) => {
    const next = normalizeModelId(raw);
    setModelDraft(next);
    if (next !== model) await onChangeModel(next);
  };
  /** False when the draft is not a usable endpoint; nothing is saved then. */
  const commitBaseUrl = async (): Promise<boolean> => {
    const raw = baseUrlDraft.trim();
    if (!raw) {
      setBaseUrlError(null);
      if (baseUrl) await onChangeBaseUrl("");
      return true;
    }
    try {
      const next = normalizeBaseUrl(raw);
      setBaseUrlDraft(next);
      setBaseUrlError(null);
      if (next !== baseUrl) await onChangeBaseUrl(next);
      return true;
    } catch (err) {
      setBaseUrlError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  const keyValid = keyDraft.trim().length >= 20;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl">Customize your homepage</DialogTitle>
          <DialogDescription>Standing instructions, privacy, model and schedule. Applied to every build.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="w-full">
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="privacy">Privacy</TabsTrigger>
            <TabsTrigger value="model">Model &amp; key</TabsTrigger>
            <TabsTrigger value="schedule">Schedule</TabsTrigger>
          </TabsList>

          {/* forceMount keeps every field in the DOM, so nothing is lost or skipped when switching tabs. */}
          <TabsContent value="content" forceMount className="data-[state=inactive]:hidden grid gap-2 pt-2">
            <Label htmlFor="instructions">Instructions</Label>
            <Textarea
              id="instructions"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
              className="min-h-52"
            />
            <p className={help}>Takes priority over the agent&apos;s defaults, for both content and look.</p>
          </TabsContent>

          <TabsContent value="privacy" forceMount className="data-[state=inactive]:hidden grid gap-2 pt-2">
            <Label htmlFor="blocked-sites">Sites the agent never reads</Label>
            <Textarea
              id="blocked-sites"
              value={blockedDraft}
              onChange={(e) => setBlockedDraft(e.target.value)}
              aria-describedby="blocked-sites-help"
              className="min-h-52 font-mono text-xs"
            />
            <p id="blocked-sites-help" className={help}>
              One per line. Subdomains are included. Use *.example.com for wildcards. Local-network addresses are always
              blocked.
            </p>
          </TabsContent>

          <TabsContent value="model" forceMount className="data-[state=inactive]:hidden grid gap-5 pt-2">
            <div className="grid gap-2">
              <Label htmlFor="model">Model</Label>
              <ModelCombobox
                id="model"
                value={modelDraft}
                onChange={setModelDraft}
                onCommit={(next) => void commitModel(next)}
                baseUrl={baseUrlDraft}
              />
              <p className={help}>
                Any OpenRouter model id that supports tool calling. Type one or pick from the list. Models ending in{" "}
                <code>:free</code> cost nothing but are rate-limited. Takes effect from the next build.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="base-url">Base URL</Label>
              <Input
                id="base-url"
                value={baseUrlDraft}
                onChange={(e) => setBaseUrlDraft(e.target.value)}
                onBlur={() => void commitBaseUrl()}
                placeholder={DEFAULT_BASE_URL}
                spellCheck={false}
                aria-invalid={baseUrlError ? true : undefined}
                className="font-mono"
              />
              <p className={baseUrlError ? "text-xs text-destructive" : help}>
                {baseUrlError ??
                  "Optional. Leave empty for OpenRouter. Any https OpenAI-compatible endpoint works; your history and pages are sent only there."}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="api-key-replace">API key</Label>
              <div className="flex gap-2">
                <Input
                  id="api-key-replace"
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder="Paste a new key to replace the saved one"
                  autoComplete="off"
                  className="font-mono"
                />
                <Button
                  variant="secondary"
                  disabled={!keyValid}
                  onClick={async () => {
                    await onChangeApiKey(keyDraft.trim());
                    setKeyDraft("");
                    toast.success("API key replaced");
                  }}
                >
                  Replace
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="schedule" forceMount className="data-[state=inactive]:hidden grid gap-2 pt-2">
            <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
              <div className="grid gap-1">
                <Label htmlFor="auto-rebuild">Rebuild automatically each morning</Label>
                <p className={help}>
                  When on, the extension builds one morning edition a day in the background (first time Chrome is open
                  between 5am and noon), so your next tab shows a fresh one (uses your OpenRouter key; pick a :free model
                  to keep it at no cost).
                </p>
              </div>
              <Switch id="auto-rebuild" checked={autoRebuild} onCheckedChange={(v) => onToggleAutoRebuild(v)} />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              // Persist model and endpoint before the rebuild reads settings.
              if (!(await commitBaseUrl())) {
                setTab("model");
                return;
              }
              await commitModel();
              onSave(draft, normalizeBlockList(blockedDraft.split("\n")));
            }}
          >
            Save &amp; rebuild
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
