// Development builds only. Mounted by the root layout behind `__DEV__`: the
// capture channel and state links on iOS and Android, the `?stet-state=` hook
// and the preview messages on the web.
import { useNavigationContainerRef } from 'expo-router';
import { useEffect } from 'react';
import { Platform, Text, View } from 'react-native';

import { Probes } from './capture';
import { startChannel, stopChannel } from './channel';
import { applyPoint } from './recipe';
import { pendingPoint } from './state-link';
import { listenForPreviewMessages, readWebState } from './web';

const webState = Platform.OS === 'web' ? readWebState() : null;

function whenReady(navRef: any, run: () => void) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    if (!navRef?.isReady?.()) return false;
    run();
    return true;
  };
  if (!tick()) timer = setInterval(() => tick() && clearInterval(timer), 50);
  return () => clearInterval(timer);
}

export function StetDev() {
  const navRef = useNavigationContainerRef();
  const pending = pendingPoint.use();

  useEffect(() => {
    if (Platform.OS === 'web') {
      const stop = listenForPreviewMessages();
      const cancel = webState?.found
        ? whenReady(navRef, () => applyPoint(webState.point, navRef, { ...webState, keepDrafts: true }))
        : () => {};
      if (webState) window.parent?.postMessage({ type: 'stet:state', point: webState.point, found: webState.found }, '*');
      return () => (stop(), cancel());
    }
    startChannel(navRef);
    return stopChannel;
  }, [navRef]);

  useEffect(() => {
    if (!pending) return;
    return whenReady(navRef, () => {
      applyPoint(pending, navRef, {});
      pendingPoint.set(null);
    });
  }, [pending, navRef]);

  return (
    <>
      <Probes />
      {webState && !webState.found ? (
        <View style={{ position: 'absolute', inset: 0, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 16, color: '#b42318' }}>Screen not found: {webState.point}</Text>
        </View>
      ) : null}
    </>
  );
}
