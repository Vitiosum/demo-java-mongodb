package cloud.clever.observatory;

import static com.mongodb.client.model.Filters.in;
import static com.mongodb.client.model.Projections.include;

import com.mongodb.MongoBulkWriteException;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.model.IndexOptions;
import com.mongodb.client.model.Indexes;
import com.mongodb.client.model.InsertManyOptions;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.bson.Document;
import org.bson.types.ObjectId;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.stereotype.Component;

/**
 * Fills the sky at startup from catalog.json (public-domain astronomical facts).
 * Idempotent: each object has a unique "slug", only missing ones are inserted.
 * Constellations reference their stars by ObjectId, resolved here from star slugs.
 */
@Component
class SkySeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SkySeeder.class);

    private final MongoTemplate mongo;

    SkySeeder(MongoTemplate mongo) {
        this.mongo = mongo;
    }

    @Override
    public void run(ApplicationArguments args) {
        try {
            seed();
        } catch (RuntimeException | IOException e) {
            // The app still starts: /health answers, /health/deep reports the database.
            log.warn("Sky not seeded, MongoDB unreachable: {}", e.getMessage());
        }
    }

    void seed() throws IOException {
        MongoCollection<Document> sky = mongo.getCollection(SkyController.COLLECTION);
        sky.createIndex(Indexes.ascending("slug"), new IndexOptions().unique(true).sparse(true));
        sky.createIndex(Indexes.ascending("type"));
        sky.createIndex(Indexes.ascending("magnitude"));

        Set<String> present = sky.distinct("slug", String.class).into(new HashSet<>());
        List<Document> catalog = readCatalog();

        // Stars, planets, comets and deep-sky objects first, constellations after (they point at stars).
        List<Document> missing = new ArrayList<>();
        for (Document doc : catalog) {
            if (!doc.containsKey("starSlugs") && !present.contains(doc.getString("slug"))) {
                missing.add(doc);
            }
        }
        int inserted = insert(sky, missing);

        missing.clear();
        for (Document doc : catalog) {
            if (doc.containsKey("starSlugs") && !present.contains(doc.getString("slug"))) {
                missing.add(withStarReferences(sky, doc));
            }
        }
        inserted += insert(sky, missing);
        log.info("Sky ready: {} documents inserted, {} in the collection", inserted, sky.estimatedDocumentCount());
    }

    /** Replaces "starSlugs": ["betelgeuse", …] with "stars": [ObjectId(…), …]. */
    private static Document withStarReferences(MongoCollection<Document> sky, Document constellation) {
        List<String> slugs = constellation.getList("starSlugs", String.class);
        Map<String, ObjectId> ids = new HashMap<>();
        for (Document star : sky.find(in("slug", slugs)).projection(include("slug"))) {
            ids.put(star.getString("slug"), star.getObjectId("_id"));
        }
        Document doc = new Document();
        constellation.forEach((key, value) -> {
            if (key.equals("starSlugs")) {
                doc.append("stars", slugs.stream().map(ids::get).toList());
            } else {
                doc.append(key, value);
            }
        });
        return doc;
    }

    /** Unordered insert: if another instance seeded the same slug meanwhile, skip it. */
    private static int insert(MongoCollection<Document> sky, List<Document> docs) {
        if (docs.isEmpty()) {
            return 0;
        }
        try {
            return sky.insertMany(docs, new InsertManyOptions().ordered(false)).getInsertedIds().size();
        } catch (MongoBulkWriteException e) {
            return e.getWriteResult().getInsertedCount();
        }
    }

    private static List<Document> readCatalog() throws IOException {
        try (InputStream in = new ClassPathResource("catalog.json").getInputStream()) {
            String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            return Document.parse("{\"objects\": " + json + "}").getList("objects", Document.class);
        }
    }
}
