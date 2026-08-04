package app.presence.nearby;

import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Keep icon unstretched (Theme.SplashScreen draws bitmap centered).
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
    }
}
