export const HTML_FILE_NAVIGATION_MESSAGE = 'grove:html-file-navigation';

/** Keep file links inside the preview instead of resolving against Grove's origin. */
export function injectHtmlFileNavigation(html: string, frameId: string, enabled: boolean, fragment = ''): string {
  // Escape '<' because both values are embedded in an HTML script element.
  const json = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c');
  const script = String.raw`<script>(function(){
    var frameId=${json(frameId)},fragment=${json(fragment)};
    ${enabled ? String.raw`document.addEventListener('click',function(event){
      var link=event.target&&event.target.closest&&event.target.closest('a[href],area[href]');
      if(!link||event.defaultPrevented)return;
      var reference=(link.getAttribute('href')||'').trim();
      if(!reference||/^(?:[a-z][a-z0-9+.-]*:|\/|#|\?)/i.test(reference))return;
      // An explicit external base makes relative links external, too.
      var base=document.querySelector('base[href]');
      if(base){var href=base.getAttribute('href')||'';if(/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(href))return;
        if(href)reference=href.slice(0,href.lastIndexOf('/')+1)+reference;}
      event.preventDefault();event.stopImmediatePropagation();
      window.parent.postMessage({type:${json(HTML_FILE_NAVIGATION_MESSAGE)},frameId:frameId,reference:reference},'*');
    });` : ''}
    if(fragment)window.addEventListener('load',function(){
      var id=fragment.slice(1);try{id=decodeURIComponent(id);}catch(_){}
      var target=document.getElementById(id)||document.getElementsByName(id)[0];
      if(target)target.scrollIntoView();
    });
  })();</script>`;
  // Install before page scripts so native anchors are caught before navigation.
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (head) => head + script)
    : script + html;
}
