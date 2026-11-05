package com.pollardbilliard.pos;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String POS_URL = "https://192.168.1.140:3100";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView.setWebContentsDebuggingEnabled(true);

        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().loadUrl(POS_URL);
        }
    }
}