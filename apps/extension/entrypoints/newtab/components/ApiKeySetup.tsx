import { useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ApiKeySetup({ onSave }: { onSave: (key: string) => void }) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const valid = trimmed.length >= 20 && !/\s/.test(trimmed);
  const looksLikeOpenRouter = trimmed.startsWith("sk-or-");

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRoundIcon className="size-5" />
          </div>
          <CardTitle className="text-2xl">Connect your OpenRouter API key</CardTitle>
          <CardDescription className="leading-relaxed">
            The agent runs inside this extension and talks to{" "}
            <a className="font-medium text-primary underline-offset-4 hover:underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
              OpenRouter
            </a>{" "}
            directly (or the compatible endpoint you set in Settings). Your key is stored in{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">chrome.storage.local</code> on this machine and is only
            ever sent to that endpoint.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="api-key-form"
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) onSave(trimmed);
            }}
          >
            <Label htmlFor="api-key">API key</Label>
            <Input
              id="api-key"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="sk-or-v1-..."
              autoComplete="off"
              className="font-mono"
            />
            {valid && !looksLikeOpenRouter && (
              <p className="text-xs text-amber-700">
                This doesn&apos;t look like an OpenRouter key (they start with sk-or-). That&apos;s fine if you point the
                base URL in Settings at another OpenAI-compatible endpoint.
              </p>
            )}
          </form>
        </CardContent>
        <CardFooter>
          <Button type="submit" form="api-key-form" disabled={!valid}>
            Save key
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
