import { VSCodeButton, VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react";
import cn from "classnames";

import { Body, Label } from "./ui/Text";
import React, { useState } from "react";
import { TEXT } from "../globals/ux-text";
import { PanelSection } from "./ui/PanelSection";
import { Spacer } from "./ui/Spacer";
import styles from "../sidebar.entry.scss";

export function InitFirebasePanel({
  onHostingInit,
}: {
  onHostingInit: Function;
}) {
  const [ initInProgress, setInitInProgress ] = useState<boolean>(false);
  if (initInProgress) {
    return (
      <PanelSection isLast>
        <Spacer size="medium" />
        <div className={styles.integrationStatus}>
          <VSCodeProgressRing
            className={cn(
              styles.integrationStatusIcon,
              styles.integrationStatusLoading
            )}
          />
          <Label level={3}>{TEXT.INIT_HOSTING_PROGRESS}</Label>
        </div>
      </PanelSection>
    );
  }
  return (
    <PanelSection isLast>
      <VSCodeButton
        onClick={() => {
          onHostingInit();
          setInitInProgress(true);
        }}
      >
        {TEXT.INIT_HOSTING_BUTTON}
      </VSCodeButton>
      <Spacer size="medium" />
      <Body>{TEXT.INIT_HOSTING_DESCRIPTION}</Body>
      <Spacer size="large" />
    </PanelSection>
  );
}
