package com.cmhunt.iptvlive.ui.categories

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.cmhunt.iptvlive.AppContainer
import com.cmhunt.iptvlive.data.ChannelSearch
import com.cmhunt.iptvlive.data.db.CategoryWithCount
import com.cmhunt.iptvlive.ui.channels.Message
import com.cmhunt.iptvlive.ui.channels.SearchField
import com.cmhunt.iptvlive.ui.channels.countLabel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

data class CategoriesState(val rows: List<CategoryWithCount> = emptyList(), val total: Int = 0)

@OptIn(FlowPreview::class)
class CategoriesViewModel(container: AppContainer) : ViewModel() {
    val query = MutableStateFlow("")

    val state: StateFlow<CategoriesState> =
        combine(container.catalogue.categoriesWithCounts.map { ChannelSearch(it) { c -> c.name } }, query.debounce(100)) { idx, q ->
            CategoriesState(idx.search(q), idx.search("").size)
        }
            .flowOn(Dispatchers.Default)
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), CategoriesState())
}

@Composable
fun CategoriesScreen(container: AppContainer, onOpen: (String) -> Unit) {
    val vm = viewModel { CategoriesViewModel(container) }
    val state by vm.state.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize()) {
        SearchField(query, { vm.query.value = it }, "Search ${countLabel(state.total, "category", "categories")}")
        if (state.rows.isEmpty() && query.isNotBlank()) {
            Message("No categories match \"$query\".")
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(state.rows, key = { it.id }) { cat ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { onOpen(cat.id) }
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            cat.name,
                            style = MaterialTheme.typography.bodyLarge,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.width(12.dp))
                        Text(
                            "%,d".format(cat.count),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
