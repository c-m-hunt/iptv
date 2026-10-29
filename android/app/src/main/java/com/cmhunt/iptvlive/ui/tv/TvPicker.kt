package com.cmhunt.iptvlive.ui.tv

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ConnectedTv
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.dlna.DlnaDevice
import kotlinx.coroutines.launch

/** The TV icon for a top bar: highlighted while a TV is selected; opens the picker. */
@Composable
fun TvButton(container: AppContainer, tint: Color = Color.Unspecified) {
    val state by container.tv.state.collectAsStateWithLifecycle()
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }) {
        if (state.device != null) {
            Icon(Icons.Filled.ConnectedTv, "Playing on ${state.device?.name}", tint = MaterialTheme.colorScheme.primary)
        } else {
            Icon(Icons.Filled.Tv, "Play on TV", tint = if (tint == Color.Unspecified) MaterialTheme.colorScheme.onSurface else tint)
        }
    }
    if (open) TvPickerSheet(container, onDismiss = { open = false })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TvPickerSheet(container: AppContainer, onDismiss: () -> Unit) {
    val tv = container.tv
    val state by tv.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    var devices by remember { mutableStateOf<List<DlnaDevice>>(emptyList()) }
    var searching by remember { mutableStateOf(true) }
    var searchCount by remember { mutableIntStateOf(0) }
    var address by rememberSaveable { mutableStateOf("") }
    var addError by remember { mutableStateOf<String?>(null) }

    // The relay shows a notification while it runs; Android 13+ asks first.
    // Playing on the TV works either way, so the answer is not checked.
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    fun choose(device: DlnaDevice) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        tv.select(device)
        onDismiss()
    }

    LaunchedEffect(searchCount) {
        searching = true
        val found = runCatching { tv.discover() }.getOrDefault(emptyList())
        devices = (devices + found).distinctBy { it.udn }
        searching = false
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding()
                .padding(bottom = 16.dp),
        ) {
            Text("Play on TV", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp))

            state.device?.let { current ->
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        "Connected to ${current.name}",
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.weight(1f),
                    )
                    OutlinedButton(onClick = { tv.disconnect(); onDismiss() }) { Text("Play on phone") }
                }
            }

            if (searching) {
                LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 12.dp))
            }
            for (d in devices) {
                val selected = d.udn == state.device?.udn
                ListItem(
                    headlineContent = { Text(d.name) },
                    supportingContent = {
                        val sub = listOf(d.manufacturer, d.model).filter { it.isNotBlank() }.joinToString(" · ")
                        Text(sub.ifEmpty { d.host })
                    },
                    leadingContent = { Icon(Icons.Filled.Tv, null) },
                    trailingContent = { if (selected) Icon(Icons.Filled.Check, "Selected") },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.clickable { choose(d) },
                )
            }
            if (!searching && devices.isEmpty()) {
                Text(
                    "No TVs found. Check that the TV is on, on the same Wi-Fi, and that DLNA or " +
                        "\"Media sharing\" is allowed in its settings.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
                )
            }
            TextButton(
                onClick = { searchCount++ },
                enabled = !searching,
                modifier = Modifier.padding(horizontal = 12.dp),
            ) { Text(if (searching) "Searching your network…" else "Search again") }

            // Some routers block the multicast discovery needs.
            Text(
                "Or add a TV by its IP address",
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 12.dp),
            )
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                fun add() {
                    addError = null
                    scope.launch {
                        runCatching { tv.addByAddress(address) }
                            .onSuccess { choose(it) }
                            .onFailure { addError = it.message }
                    }
                }
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it; addError = null },
                    placeholder = { Text("192.168.1.50") },
                    singleLine = true,
                    isError = addError != null,
                    supportingText = addError?.let { { Text(it) } },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { add() }),
                    modifier = Modifier.weight(1f),
                )
                OutlinedButton(onClick = { add() }, enabled = address.isNotBlank()) { Text("Add") }
            }
        }
    }
}
