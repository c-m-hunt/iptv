#!/usr/bin/env bash
#
# winx_find.sh — search an Xtream Codes IPTV catalogue and print a
# VLC-playable stream URL.
#
# Configure via env vars (or webui/.env): IPTV_USERNAME, IPTV_PASSWORD,
# IPTV_LOGIN_URL, IPTV_SERVER, IPTV_PORT. Alternatively point IPTV_LS_DB at a
# desktop IPTV app's localStorage (file__0.localstorage) to read them from there.
#
# Requires: bash 3.2+, curl, jq, sqlite3 (all preinstalled on macOS).

set -euo pipefail

# Load local config from webui/.env if present (gitignored).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/webui/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/webui/.env"
  set +a
fi

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/iptv-find"
CACHE_TTL=${CACHE_TTL:-21600}   # 6h

OPEN_IN_VLC=0
NEW_WINDOW=0
FORCE_REFRESH=0
LIMIT=20
TYPE="live"
EPISODES_OF=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options] <hint words...>

Searches the IPTV catalog and prints stream URLs whose name contains ALL of
the hint words (case-insensitive).

Options:
  -t, --type T     What to search: live | movie | series (default: live)
  -e, --episodes ID  List episodes for a series_id (from a -t series search)
  -o, --open       Open the result in VLC. Behaviour:
                     live / movie: single match → opens that stream
                     series:       single match → opens ALL its episodes as a playlist
                     episodes:     opens matched episodes as a playlist
  -N, --new-window Force a NEW VLC window (so two streams can play in parallel).
                   Otherwise -o re-uses the existing VLC instance.
  -r, --refresh    Force-refresh the catalogue cache before searching
  -n N             Show at most N matches (default 20)
  -h, --help       Show this help

Examples:
  $(basename "$0") sky sports 1 fhd
  $(basename "$0") -t movie inception
  $(basename "$0") -t movie -o the matrix 1999
  $(basename "$0") -t series breaking bad
  $(basename "$0") -t series -o breaking bad         # play full series in VLC
  $(basename "$0") -e 10689                          # list episodes by series_id
  $(basename "$0") -e 10689 s01                      # filter to season 1
  $(basename "$0") -e 10689 -o                       # play full series in VLC
  $(basename "$0") --refresh -t movie
EOF
}

# -- args --------------------------------------------------------------------
HINT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--type)     TYPE="$2"; shift 2 ;;
    -e|--episodes) EPISODES_OF="$2"; shift 2 ;;
    -o|--open)     OPEN_IN_VLC=1; shift ;;
    -N|--new-window) NEW_WINDOW=1; OPEN_IN_VLC=1; shift ;;
    -r|--refresh)  FORCE_REFRESH=1; shift ;;
    -n)            LIMIT="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    --) shift; HINT+=("$@"); break ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 1 ;;
    *)  HINT+=("$1"); shift ;;
  esac
done

case "$TYPE" in
  live)   ACTION="get_live_streams"; URL_SEG="live" ;;
  movie)  ACTION="get_vod_streams";  URL_SEG="movie" ;;
  series) ACTION="get_series";       URL_SEG="series" ;;
  *) echo "Error: --type must be one of: live, movie, series" >&2; exit 1 ;;
esac

if (( NEW_WINDOW )); then
  OPEN_CMD="open -na VLC"
else
  OPEN_CMD="open -a VLC"
fi

CACHE_JSON="$CACHE_DIR/${TYPE}_streams.json"
CACHE_TSV="$CACHE_DIR/${TYPE}_streams.tsv"

# -- credentials -------------------------------------------------------------
U=""; P=""; LOGIN=""; SERVER=""; PORT=""

LS_DB="${IPTV_LS_DB:-}"
if [[ -n "$LS_DB" && -f "$LS_DB" ]]; then
  TMP_DB=$(mktemp -t iptv-ls.XXXXXX)
  cp "$LS_DB" "$TMP_DB"
  profile=$(sqlite3 "$TMP_DB" "SELECT value FROM ItemTable WHERE key='profile';" 2>/dev/null || true)
  rm -f "$TMP_DB"
  if [[ -n "${profile:-}" ]]; then
    U=$(jq -r '.user_info.username // ""'   <<< "$profile")
    P=$(jq -r '.user_info.password // ""'   <<< "$profile")
    LOGIN=$(jq -r '.user_info.login_url // ""' <<< "$profile")
    SERVER=$(jq -r '.server_info.url // ""' <<< "$profile")
    PORT=$(jq -r '.server_info.port // ""'  <<< "$profile")
  fi
fi

U="${IPTV_USERNAME:-$U}"
P="${IPTV_PASSWORD:-$P}"
LOGIN="${IPTV_LOGIN_URL:-${LOGIN:-}}"
SERVER="${IPTV_SERVER:-${SERVER:-}}"
PORT="${IPTV_PORT:-${PORT:-80}}"

if [[ -z "$U" || -z "$P" || -z "$LOGIN" || -z "$SERVER" ]]; then
  echo "Error: IPTV not configured. Set IPTV_USERNAME/PASSWORD/LOGIN_URL/SERVER" >&2
  echo "       (or IPTV_LS_DB) — see webui/.env.example." >&2
  exit 1
fi

# -- cache -------------------------------------------------------------------
mkdir -p "$CACHE_DIR" "$CACHE_DIR/playlists"
cache_age() {
  [[ -f "$1" ]] || { echo 99999999; return; }
  echo $(( $(date +%s) - $(stat -f %m "$1") ))
}

# Fetch get_series_info and emit a sorted episode TSV:
#   <episode_id>\t<ext>\tS##E##\t<title>
ensure_episodes_cache() {
  local sid="$1"
  local json="$CACHE_DIR/series_${sid}.json"
  local tsv="$CACHE_DIR/series_${sid}.tsv"
  if (( FORCE_REFRESH )) || (( $(cache_age "$json") > CACHE_TTL )); then
    echo "Fetching episodes for series_id=$sid ..." >&2
    curl -sSfG "$LOGIN/player_api.php" \
         --data-urlencode "username=$U" \
         --data-urlencode "password=$P" \
         --data-urlencode "action=get_series_info" \
         --data-urlencode "series_id=$sid" -o "$json"
    jq -r '
      .episodes // {} | to_entries
      | sort_by(.key | tonumber)
      | .[] | .key as $s | .value
      | sort_by((.episode_num | tostring | tonumber?) // 0)
      | .[]
      | [ .id,
          (.container_extension // "mkv"),
          (($s | tostring | tonumber?) // 0),
          ((.episode_num | tostring | tonumber?) // 0),
          (.title // .info.name // "")
        ]
      | @tsv
    ' "$json" | \
    while IFS=$'\t' read -r id ext season epnum title; do
      printf "%s\t%s\tS%02dE%02d\t%s\n" "$id" "$ext" "$season" "$epnum" "$title"
    done > "$tsv"
    echo "Cached $(wc -l < "$tsv" | tr -d ' ') episodes." >&2
  fi
  echo "$tsv"
}

# Build an .m3u8 playlist from an episode TSV stream (stdin).
# Each input line: <id>\t<ext>\t<S##E##>\t<title>
# Writes to the given path.
build_playlist() {
  local out="$1"
  {
    echo "#EXTM3U"
    while IFS=$'\t' read -r id ext epn ep_title; do
      [[ -z "$id" ]] && continue
      local label="$epn"
      [[ -n "$ep_title" ]] && label="$epn - $ep_title"
      echo "#EXTINF:-1,$label"
      echo "http://$SERVER:$PORT/series/$U/$P/$id.$ext"
    done
  } > "$out"
}

# -- episode listing / playlist mode ----------------------------------------
if [[ -n "$EPISODES_OF" ]]; then
  eps_tsv=$(ensure_episodes_cache "$EPISODES_OF")
  results=$(cat "$eps_tsv")
  if [[ ${#HINT[@]} -gt 0 ]]; then
    for token in "${HINT[@]}"; do
      results=$(printf '%s\n' "$results" | grep -i -F -- "$token" || true)
      [[ -z "$results" ]] && break
    done
  fi

  if [[ -z "$results" ]]; then
    echo "No episodes matched: ${HINT[*]}" >&2
    exit 2
  fi
  count=$(printf '%s\n' "$results" | wc -l | tr -d ' ')

  if (( OPEN_IN_VLC )); then
    pls="$CACHE_DIR/playlists/series_${EPISODES_OF}.m3u8"
    printf '%s\n' "$results" | build_playlist "$pls"
    echo "Opening $count episode(s) in VLC: $pls" >&2
    $OPEN_CMD "$pls"
    exit 0
  fi

  echo "Matched $count episode(s):" >&2
  echo >&2
  printf '%s\n' "$results" | head -n "$LIMIT" | while IFS=$'\t' read -r id ext epn title; do
    url="http://$SERVER:$PORT/series/$U/$P/$id.$ext"
    if [[ -n "$title" ]]; then
      printf '  %s [%s] %s\n  %s\n\n' "$epn" "$id" "$title" "$url"
    else
      printf '  %s [%s]\n  %s\n\n' "$epn" "$id" "$url"
    fi
  done
  if (( count > LIMIT )); then
    echo "... $((count - LIMIT)) more episodes (use -n to show more)" >&2
  fi
  exit 0
fi

if (( FORCE_REFRESH )) || (( $(cache_age "$CACHE_JSON") > CACHE_TTL )); then
  echo "Refreshing $TYPE catalogue from $LOGIN ..." >&2
  curl -sSfG "$LOGIN/player_api.php" \
       --data-urlencode "username=$U" \
       --data-urlencode "password=$P" \
       --data-urlencode "action=$ACTION" -o "$CACHE_JSON"
  case "$TYPE" in
    live)
      jq -r '.[] | "\(.stream_id)\tts\t\(.name)"' "$CACHE_JSON" > "$CACHE_TSV"
      ;;
    movie)
      jq -r '.[] | "\(.stream_id)\t\(.container_extension // "mp4")\t\(.name)"' "$CACHE_JSON" > "$CACHE_TSV"
      ;;
    series)
      jq -r '.[] | "\(.series_id)\t-\t\(.name)"' "$CACHE_JSON" > "$CACHE_TSV"
      ;;
  esac
  echo "Cached $(wc -l < "$CACHE_TSV" | tr -d ' ') ${TYPE} entries." >&2
fi

if [[ ${#HINT[@]} -eq 0 ]]; then
  echo "Need a search hint. Run with -h for help." >&2
  exit 1
fi

# -- search ------------------------------------------------------------------
results=$(cat "$CACHE_TSV")
for token in "${HINT[@]}"; do
  results=$(printf '%s\n' "$results" | grep -i -F -- "$token" || true)
  [[ -z "$results" ]] && break
done

if [[ -z "$results" ]]; then
  echo "No channels matched: ${HINT[*]}" >&2
  exit 2
fi

count=$(printf '%s\n' "$results" | wc -l | tr -d ' ')
echo "Matched $count channel(s):" >&2
echo >&2

build_url() {
  local id="$1" ext="$2"
  case "$TYPE" in
    live)   echo "http://$SERVER:$PORT/live/$U/$P/$id.ts" ;;
    movie)  echo "http://$SERVER:$PORT/movie/$U/$P/$id.$ext" ;;
    series) echo "(series_id=$id — fetch episodes with: action=get_series_info&series_id=$id)" ;;
  esac
}

printf '%s\n' "$results" | head -n "$LIMIT" | while IFS=$'\t' read -r id ext name; do
  url=$(build_url "$id" "$ext")
  printf '  [%s] %s\n  %s\n\n' "$id" "$name" "$url"
done

if (( count > LIMIT )); then
  echo "... $((count - LIMIT)) more (use -n to show more, or refine your hint)" >&2
fi

# -- optionally open in VLC --------------------------------------------------
if (( OPEN_IN_VLC )); then
  if (( count != 1 )); then
    echo "--open requires exactly one match; got $count. Refine your hint." >&2
    exit 3
  fi
  IFS=$'\t' read -r id ext sname <<< "$(printf '%s\n' "$results" | head -1)"
  if [[ "$TYPE" == "series" ]]; then
    eps_tsv=$(ensure_episodes_cache "$id")
    pls="$CACHE_DIR/playlists/series_${id}.m3u8"
    cat "$eps_tsv" | build_playlist "$pls"
    n=$(wc -l < "$eps_tsv" | tr -d ' ')
    echo "Built playlist of $n episode(s) → $pls" >&2
    $OPEN_CMD "$pls"
  else
    $OPEN_CMD "$(build_url "$id" "$ext")"
  fi
fi
