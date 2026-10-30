import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { RefreshCwIcon, RotateCcwIcon, SettingsIcon, SparklesIcon, XIcon } from "lucide-react";
import { DEFAULT_MODEL, DEFAULT_BLOCKED_SITES, type HomepageModel } from "@homepage/agent-core";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Toaster } from "@/components/ui/sonner";
import { BUILD_STEPS } from "@/lib/protocol";
import { KEYS, extensionStore, loadHomepage, loadSettings, saveSetting } from "@/lib/storage";
import { toRenderable } from "@/lib/transpile";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { BuildProgress } from "./components/BuildProgress";
import { HomepagePreview } from "./components/HomepagePreview";
import { SettingsModal } from "./components/SettingsModal";
import { useHomepageBuild } from "./useHomepageBuild";

export default function App() {
  return (
    <>
      <Screen />
      <Toaster position="bottom-right" />
    </>
  );
}

function Screen() {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [blockedSites, setBlockedSites] = useState<string[]>(DEFAULT_BLOCKED_SITES);
  const [model, setModel] = useState<HomepageModel>(DEFAULT_MODEL);
  const [baseUrl, setBaseUrl] = useState("");
  const [autoRebuild, setAutoRebuild] = useState(true);
  /** Transpiled homepage, ready for Sandpack. */
  const [renderedCode, setRenderedCode] = useState<string | null>(null);
  /** A session left mid-flight, offered as "Resume interrupted build". */
  const [resumable, setResumable] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const { state, build, cancel } = useHomepageBuild((code) => setRenderedCode(toRenderable(code)));

  // Once a build finishes, drop back to the homepage view.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  // Scheduled rebuilds are driven by the worker's alarm, not by opening a tab;
  // useHomepageBuild surfaces any build already in flight.
  useEffect(() => {
    (async () => {
      try {
        const [settings, homepage, activeSession] = await Promise.all([
          loadSettings(),
          loadHomepage(),
          extensionStore.get<string>(KEYS.activeSessionId),
        ]);
        setApiKey(settings.apiKey);
        setSystemPrompt(settings.systemPrompt);
        setBlockedSites(settings.blockedSites);
        setModel(settings.model);
        setBaseUrl(settings.baseUrl);
        setAutoRebuild(settings.autoRebuild);
        setResumable(activeSession ?? null);
        if (homepage?.code) setRenderedCode(toRenderable(homepage.code));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveKey = useCallback(async (key: string) => {
    await saveSetting("apiKey", key);
    setApiKey(key);
    toast.success("API key saved");
  }, []);

  const savePrompt = useCallback(
    async (prompt: string, sites: string[]) => {
      await Promise.all([saveSetting("systemPrompt", prompt), saveSetting("blockedSites", sites)]);
      setBlockedSites(sites);
      setSystemPrompt(prompt);
      setShowSettings(false);
      setRenderedCode(null);
      toast.success("Settings saved, rebuilding");
      build();
    },
    [build],
  );

  // These persist immediately; the worker reads them on its next heartbeat or build.
  const changeModel = useCallback(async (next: HomepageModel) => {
    setModel(next);
    await saveSetting("model", next);
    toast.success("Model saved", { description: next });
  }, []);
  const changeBaseUrl = useCallback(async (next: string) => {
    setBaseUrl(next);
    await saveSetting("baseUrl", next);
  }, []);
  const changeApiKey = useCallback(async (next: string) => {
    setApiKey(next);
    await saveSetting("apiKey", next);
  }, []);
  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);

  if (loading) return <div className="p-5 text-center text-sm text-muted-foreground">Loading…</div>;
  if (!apiKey) return <ApiKeySetup onSave={saveKey} />;

  const settings = showSettings && (
    <SettingsModal
      initialPrompt={systemPrompt}
      blockedSites={blockedSites}
      model={model}
      onChangeModel={changeModel}
      baseUrl={baseUrl}
      onChangeBaseUrl={changeBaseUrl}
      onChangeApiKey={changeApiKey}
      autoRebuild={autoRebuild}
      onToggleAutoRebuild={toggleAutoRebuild}
      onClose={() => setShowSettings(false)}
      onSave={savePrompt}
    />
  );

  // With no homepage to fall back to, a running build takes over the tab.
  if (state.running && (!renderedCode || viewProgress)) {
    return (
      <BuildProgress
        state={state}
        onCancel={cancel}
        onBack={renderedCode ? () => setViewProgress(false) : undefined}
      />
    );
  }

  if (!renderedCode) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <SparklesIcon className="size-5" />
            </div>
            <CardTitle className="text-2xl">Build your homepage</CardTitle>
            <CardDescription className="leading-relaxed">
              The agent reads your browsing history, opens the pages you actually follow, and writes a homepage from what
              it finds today.
            </CardDescription>
          </CardHeader>
          {state.error && (
            <CardContent>
              <Alert variant="destructive">
                <AlertTitle>Build failed</AlertTitle>
                <AlertDescription>{state.error}</AlertDescription>
              </Alert>
            </CardContent>
          )}
          <CardFooter className="flex flex-wrap gap-3">
            <Button onClick={() => build()}>Build today&apos;s homepage</Button>
            {resumable && (
              <Button variant="secondary" onClick={() => build({ resume: true })}>
                <RotateCcwIcon /> Resume interrupted build
              </Button>
            )}
            <Button variant="ghost" className="ml-auto" onClick={() => setShowSettings(true)}>
              <SettingsIcon /> Settings
            </Button>
          </CardFooter>
        </Card>
        {settings}
      </main>
    );
  }

  const showError = state.error && dismissedError !== state.error;

  return (
    <div className="h-screen w-screen">
      <div className="fixed top-5 right-5 z-[999] flex gap-2">
        {state.running ? (
          // A build is running in the background (from here, another tab, or the
          // scheduled rebuild). Let the user watch it without losing this page.
          <Button
            className="bg-emerald-600 shadow-md hover:bg-emerald-600/90"
            onClick={() => setViewProgress(true)}
            title="View build progress"
          >
            <span className="size-2 rounded-full bg-white [animation:hb-pulse_1.2s_ease-in-out_infinite]" />
            Building… {Math.min(state.stepIndex + 1, BUILD_STEPS.length)}/{BUILD_STEPS.length}
          </Button>
        ) : (
          <Button className="shadow-md" onClick={() => build()} title="Rebuild now">
            <RefreshCwIcon /> Rebuild
          </Button>
        )}
        <Button variant="outline" className="shadow-md" onClick={() => setShowSettings(true)} title="Customize homepage">
          <SettingsIcon /> Settings
        </Button>
      </div>

      {showError && (
        <Alert variant="destructive" className="fixed top-5 right-[300px] left-5 z-[999] bg-background shadow-md">
          <AlertTitle>Build failed</AlertTitle>
          <AlertDescription className="flex w-full items-start gap-3">
            <span className="flex-1">{state.error}</span>
            <Button size="sm" variant="destructive" onClick={() => build()}>
              Retry
            </Button>
            <Button size="icon" variant="ghost" className="size-8" onClick={() => setDismissedError(state.error)} title="Dismiss">
              <XIcon />
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <HomepagePreview code={renderedCode} />

      {settings}
    </div>
  );
}
