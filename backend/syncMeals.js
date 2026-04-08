// backend/syncMeals.js
// Instagram 급식 사진 크롤링 → Cloudinary 업로드 → meal_day_images 테이블 동기화
const cloudinary = require('cloudinary').v2;

const {
  ensureMealDayImagesTable,
  getMealImagesByDates,
  upsertMealImage,
} = require('./mealDayImages');

const INSTAGRAM_USERNAME  = 'daeshin_council';
const INSTAGRAM_APP_ID    = '936619743392459';
const INSTAGRAM_FEED_COUNT = 20;
const KST_TIME_ZONE       = 'Asia/Seoul';

const WEEK_ORDINAL = {
  '첫째': 1,
  '둘째': 2,
  '셋째': 3,
  '넷째': 4,
  '다섯째': 5,
};

// 캡션에서 "N월 첫째/둘째/... 주" 패턴 인식
const WEEK_LABEL_RE = /(\d{1,2})\s*월\s*(첫째|둘째|셋째|넷째|다섯째)\s*주/;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── 헬퍼 ────────────────────────────────────────────────

function getCaptionText(item) {
  return typeof item?.caption?.text === 'string' ? item.caption.text.trim() : '';
}

function getKstPartsFromUnixSeconds(seconds) {
  const d = new Date(Number(seconds) * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const m = {};
  for (const part of parts) {
    if (part.type !== 'literal') m[part.type] = part.value;
  }
  return {
    year:    Number(m.year),
    month:   Number(m.month),
    day:     Number(m.day),
    hours:   Number(m.hour),
    minutes: Number(m.minute),
    seconds: Number(m.second),
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateUtc(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function formatKstDateTime(seconds) {
  const p = getKstPartsFromUnixSeconds(seconds);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hours)}:${pad2(p.minutes)}:${pad2(p.seconds)}`;
}

// 게시 월과 캡션 월이 다를 때 연도 보정 (12월 게시 → 1월 캡션 등)
function inferSchoolWeekYear(postYear, postMonth, captionMonth) {
  if (postMonth === 12 && captionMonth === 1)  return postYear + 1;
  if (postMonth === 1  && captionMonth === 12) return postYear - 1;
  return postYear;
}

// 특정 연월의 n번째 주 월~금 날짜 배열 반환 (UTC 기준)
function getWeekDates(year, month, ordinal) {
  const firstDay = new Date(Date.UTC(year, month - 1, 1));
  const firstMondayOffset = (1 - firstDay.getUTCDay() + 7) % 7;
  const monday = new Date(Date.UTC(
    year, month - 1,
    1 + firstMondayOffset + (ordinal - 1) * 7
  ));

  // 해당 월을 벗어나면 빈 배열
  if ((monday.getUTCMonth() + 1) !== month) return [];

  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday.getTime() + i * 24 * 60 * 60 * 1000);
    return formatDateUtc(d);
  });
}

function getBestImageUrl(media) {
  const candidates = media?.image_versions2?.candidates;
  if (Array.isArray(candidates) && candidates.length) return candidates[0].url;
  return null;
}

// ── Instagram API ─────────────────────────────────────

async function fetchInstagramFeed(count = INSTAGRAM_FEED_COUNT) {
  const url = `https://www.instagram.com/api/v1/feed/user/${INSTAGRAM_USERNAME}/username/?count=${count}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':       'Mozilla/5.0',
      'x-ig-app-id':      INSTAGRAM_APP_ID,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer':          `https://www.instagram.com/${INSTAGRAM_USERNAME}/`,
    },
  });
  if (!res.ok) throw new Error(`Instagram feed 요청 실패: ${res.status}`);
  return res.json();
}

// 피드 아이템에서 주별 최신 급식 게시물만 추출
function collectLatestWeeklyMealPosts(items) {
  const latestByWeek = new Map();

  for (const item of items) {
    const caption = getCaptionText(item);
    if (!caption.includes('급식') && !caption.includes('석식')) continue;

    const match = caption.match(WEEK_LABEL_RE);
    if (!match) continue;

    // 캐러셀(슬라이드 6장)이어야 함: 표지 1장 + 월~금 5장
    if (item.media_type !== 8 || !Array.isArray(item.carousel_media) || item.carousel_media.length !== 6) {
      console.log(`[mealSync] 스킵 ${item.code}: 캐러셀 슬라이드 수 불일치`);
      continue;
    }

    const postParts   = getKstPartsFromUnixSeconds(item.taken_at);
    const captionMonth = Number(match[1]);
    const ordinalText  = match[2];
    const ordinal      = WEEK_ORDINAL[ordinalText];
    const year         = inferSchoolWeekYear(postParts.year, postParts.month, captionMonth);
    const weekDates    = getWeekDates(year, captionMonth, ordinal);

    if (weekDates.length !== 5) {
      console.log(`[mealSync] 스킵 ${item.code}: ${captionMonth}월 ${ordinalText} 주 날짜 산출 실패`);
      continue;
    }

    const weekKey = `${year}-${pad2(captionMonth)}-${ordinal}`;
    const candidate = {
      code:          item.code,
      taken_at:      Number(item.taken_at),
      caption,
      week_label:    `${captionMonth}월 ${ordinalText} 주`,
      week_key:      weekKey,
      week_dates:    weekDates,
      carousel_media: item.carousel_media,
    };

    const current = latestByWeek.get(weekKey);
    if (!current || candidate.taken_at > current.taken_at) {
      latestByWeek.set(weekKey, candidate);
    }
  }

  return Array.from(latestByWeek.values()).sort((a, b) => b.taken_at - a.taken_at);
}

// ── Cloudinary 업로드 ─────────────────────────────────

function ensureCloudinaryConfig() {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error('Cloudinary 환경변수(CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET)가 설정되지 않았습니다.');
  }
}

async function uploadInstagramImageToCloudinary(imageUrl, publicId) {
  const res = await fetch(imageUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error(`Instagram 이미지 다운로드 실패: ${res.status}`);

  const mime    = res.headers.get('content-type') || 'image/jpeg';
  const buffer  = Buffer.from(await res.arrayBuffer());
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`;

  const result = await cloudinary.uploader.upload(dataUri, {
    folder:          'schoolboard/meals',
    public_id:       publicId,
    overwrite:       true,
    transformation:  [{ width: 1600, crop: 'limit', quality: 'auto' }],
  });

  return result.secure_url;
}

// ── 주 단위 sync ──────────────────────────────────────

async function syncSingleWeek(weeklyPost) {
  const existingRows  = await getMealImagesByDates(weeklyPost.week_dates);
  const existingByDate = new Map(existingRows.map(row => [row.date, row]));

  let upserted = 0, uploaded = 0, reused = 0;

  for (let dayIndex = 0; dayIndex < 5; dayIndex++) {
    const date       = weeklyPost.week_dates[dayIndex];
    const slideIndex = dayIndex + 2; // 캐러셀 슬라이드 2~6 (인덱스 1~5)
    const media      = weeklyPost.carousel_media[slideIndex - 1];
    const imageUrl   = getBestImageUrl(media);

    if (!imageUrl) {
      throw new Error(`${weeklyPost.code} 슬라이드 ${slideIndex} 이미지 URL 없음`);
    }

    const existing = existingByDate.get(date);

    // 같은 게시물·같은 슬라이드면 Cloudinary 재업로드 생략
    const canReuse = Boolean(
      existing &&
      existing.source_post_code  === weeklyPost.code &&
      Number(existing.source_slide_index) === slideIndex &&
      existing.image_url
    );

    let finalImageUrl;
    if (canReuse) {
      finalImageUrl = existing.image_url;
      reused++;
    } else {
      finalImageUrl = await uploadInstagramImageToCloudinary(
        imageUrl,
        `meal-${date}-${weeklyPost.code}-slide-${slideIndex}`
      );
      uploaded++;
    }

    await upsertMealImage({
      date,
      image_url:          finalImageUrl,
      week_label:         weeklyPost.week_label,
      source_post_code:   weeklyPost.code,
      source_caption:     weeklyPost.caption,
      source_taken_at:    formatKstDateTime(weeklyPost.taken_at),
      source_slide_index: slideIndex,
    });
    upserted++;
  }

  return { upserted, uploaded, reused };
}

// ── 메인 export ───────────────────────────────────────

async function syncInstagramMealImages() {
  ensureCloudinaryConfig();
  await ensureMealDayImagesTable();

  console.log('[mealSync] Instagram 급식 사진 sync 시작');
  const feed  = await fetchInstagramFeed();
  const items = Array.isArray(feed?.items) ? feed.items : [];
  const weeklyPosts = collectLatestWeeklyMealPosts(items);
  console.log(`[mealSync] 피드 ${items.length}건 스캔, 주별 게시물 ${weeklyPosts.length}개`);

  let upserted = 0, uploaded = 0, reused = 0, failed = 0;

  for (const weeklyPost of weeklyPosts) {
    try {
      const result = await syncSingleWeek(weeklyPost);
      upserted += result.upserted;
      uploaded += result.uploaded;
      reused   += result.reused;
      console.log(`[mealSync] 완료: ${weeklyPost.week_label} (${weeklyPost.code})`);
    } catch (err) {
      failed++;
      console.error(`[mealSync] 실패: ${weeklyPost.week_label} (${weeklyPost.code}):`, err.message);
    }
  }

  const summary = {
    scanned_posts: items.length,
    weekly_posts:  weeklyPosts.length,
    upserted,
    uploaded,
    reused,
    failed,
  };
  console.log('[mealSync] 완료', summary);
  return summary;
}

module.exports = {
  syncInstagramMealImages,
  fetchInstagramFeed,
  collectLatestWeeklyMealPosts,
};
