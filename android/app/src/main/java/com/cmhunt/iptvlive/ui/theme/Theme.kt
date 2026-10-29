package com.cmhunt.iptvlive.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Always dark: this is a TV app, usually watched with the lights down.
private val colors = darkColorScheme(
    primary = Color(0xFF4FC3F7),
    onPrimary = Color(0xFF00222E),
    primaryContainer = Color(0xFF0B3A4C),
    onPrimaryContainer = Color(0xFFBFE9FB),
    background = Color(0xFF0F1115),
    onBackground = Color(0xFFE3E5EA),
    surface = Color(0xFF0F1115),
    onSurface = Color(0xFFE3E5EA),
    surfaceVariant = Color(0xFF1C2028),
    onSurfaceVariant = Color(0xFFA9B0BC),
    surfaceContainer = Color(0xFF171A21),
    surfaceContainerHigh = Color(0xFF1E222A),
    surfaceContainerHighest = Color(0xFF252A33),
    error = Color(0xFFFF8A80),
)

@Composable
fun IptvTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, content = content)
}
