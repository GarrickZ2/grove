import { useEffect, useState } from "react";
import { appendHmacToUrl, getMachineApiBase } from "../../api/client";
import { useAuthenticatedFileUrl } from "../../hooks/useAuthenticatedFileUrl";

/**
 * A URL for `<img src>`; null until ready. Signed for this client at home. A
 * paired machine's port refuses image requests, so there the bytes are fetched.
 */
export function useSignedUrl(url: string | null): string | null {
  const machine = Boolean(getMachineApiBase());
  const signedUrl = useHomeSignedUrl(machine ? null : url);
  const { url: fetchedUrl } = useAuthenticatedFileUrl(machine ? url : null);
  return machine ? fetchedUrl : signedUrl;
}

function useHomeSignedUrl(url: string | null): string | null {
  const [signed, setSigned] = useState<{ url: string; signed: string } | null>(null);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void appendHmacToUrl(url).then((value) => {
      if (alive) setSigned({ url, signed: value });
    }).catch(() => {
      if (alive) setSigned(null);
    });
    return () => { alive = false; };
  }, [url]);
  return url && signed?.url === url ? signed.signed : null;
}
